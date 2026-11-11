// The local review as a typed call: `review(target, opts, io)` runs the whole
// pipeline below argument parsing, and `preview(target, opts, io)` stops at
// the plan and the price. `qcr review` (src/reviewcli.ts) is a thin adapter
// over these: it parses argv, resolves the homes and the config, builds the
// ports from the terminal and prints what comes back. A pi plugin builds the
// same ports from its own session.
//
// The pipeline: resolve the target (the current branch, the uncommitted tree,
// a unified diff, or a PR fetched into a scratch repository), settle where the
// result goes, read what an earlier review of the target left (an unchanged
// head is free, a push is a delta review over the production follow-up plan,
// packages/pi-plugin/src/reviewdelta.ts), plan the round, learn the model it runs on (the
// host's `route`), price it, ask above the limit, isolate the run (the host's
// `prepareHost`), run the one-shot round, skip what the bot already posted,
// record the round, render, and post through the one gate when asked.
//
// The price. What a review costs is known from one of five things
// (packages/pi-plugin/src/measured.ts `priceBasis`), and each has its own
// line, stop and question:
//
//   measured, repo   an estimate (the fit, or the repo's own rates); the run
//                    stops hard at twice it, and asks above the repo's limit.
//   unmeasured       no estimate; the run stops at a spend limit (`--limit`,
//                    else the repo's `unmeasured_limit_usd`) and needs the
//                    person's word once: `--limit` on the run, a yes at a
//                    terminal or a start with the preview's key, the last two
//                    remembered beside pi's logins (modelchoice.ts).
//   unpriced         pi has no price for the model, so it counts no cost and
//                    no dollar figure can stop the run: the time limit holds.
//                    The same holds where the repo's rates give an estimate
//                    on such a model: the estimate is shown, the stop is not.
//   unknown          no model route resolves: a preview says so, a start is
//                    refused.
//
// The JSON is review schema 2. A caller that reads contract 1 (`contract`)
// gets the same payload under version 1 while its estimate is a number, and
// is refused before anything runs where it is not: version 1 has no way to
// say "no estimate", and a guess is never printed in its place.
//
// The model is the host's to resolve, since the host knows where pi's
// credentials are: `opts.route` answers with the route (or why there is
// none) once the plan exists, so a target that needs no review asks nothing.
// The preview names the model and the reason in one line, carries it as
// `model`, `alternatives` and `tiers`, and puts every spec the run will use
// into the key; a start with no route is refused in the route's own words.
//
// Nothing here reads the caller's cwd, home or config file: every path, the
// config and the runtime are options, and every word for a person goes
// through the ports. The process environment is still read where a child
// needs it: git and the reviewer session inherit PATH and HOME (the session
// also an API key the key route names, packages/pi-plugin/src/engine/round.ts), and a PR's
// credential chain reads GH_TOKEN, GITHUB_TOKEN and `gh`'s login unless
// `opts.github.env` (and its other sources) are given. A stop (`io.signal`)
// ends the run with a result, never the process; every git step that can
// take long (the PR fetch, the review tree's clone and checkout) runs as a
// child the event loop waits on, so the stop is heard while it runs.
//
// Exit codes follow `qcr scan`: 0 done; 1 refused, declined, failed or
// stopped short (partial); 2 usage.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { splitModelSpec, type CoreConfig } from "./reviewconfig.js";
import type { Ecosystem } from "./ecosystem.js";
import {
  addDiffTree,
  addReviewTree,
  addUncommittedTree,
  contractOneNoPrice,
  groupFindings,
  loadReviewSettings,
  hardStopFor,
  priceReview,
  removeReviewTree,
  renderGrouped,
  repoRates,
  originRepo,
  resolveBranch,
  resolveDiff,
  resolveUncommitted,
  reviewForContract,
  reviewKey,
  runModels,
  tooShortFor,
  type BranchTarget,
  type RunRoute,
} from "./localreview.js";
import { MEASURED, measuredSpec, priceBasis, type PriceBasis } from "./measured.js";
import { allowNoEstimate, readModelChoice } from "./modelchoice.js";
import {
  refusalText,
  RouteRefused,
  routeNoticeLines,
  type ModelRoute,
  type ProviderCredential,
  type ProviderInventory,
  type RefusalFacts,
  type RouteResult,
  type RouteSurface,
  type SkippedLogin,
} from "./modelroute.js";
import { MEMORY_NOT_SET_UP, type ReviewMemoryPort, type RoundMemory } from "./memoryport.js";
import type { ProfilePlace } from "./profilelookup.js";
import type { ProfileLookup } from "./profiles.js";
import { assemblePostReview, loadPostIdentity, securityRowsNotReturned } from "./reviewpost.js";
import {
  fetchPrTarget,
  parsePrTarget,
  resolvePostCredential,
  resolvePrCredential,
  type CredentialSource,
} from "./prtarget.js";
import {
  FALLBACK_DESTINATIONS,
  destinationChoices,
  loadDefaultDestinationsIn,
  renderMarkdown,
  saveDefaultDestinationsIn,
  type Destination,
  type DestinationChoice,
} from "./reviewdest.js";
import { runOneShot, type OneShotResult } from "./oneshot.js";
import type { RoundSpec } from "./engine/round.js";
import { renderOneShotPrompts, type OneShotPrompts } from "./engine/prompts.js";
import { AuthError, AuthExpiring } from "./engine/auth.js";
import type { Runtime } from "./engine/port.js";
import type { SecurityRequest } from "./types.js";
import { computeSecurityFacts, SECURITY_TRIGGER_CHECKS, type SecurityFact } from "./secfacts.js";
import { localGitFactsIo, workTreeFactsIo } from "./secfactsgit.js";
import { SECURITY_FAMILY } from "./passes.js";
import { lensEnabled } from "./lenstuning.js";
import { fetchBotFindings, skipPosted, type PostedFinding } from "./reviewbotfindings.js";
import { computeDelta, deltaEnabled, renderDeltaRound, type DeltaFound } from "./reviewdelta.js";
import { reviewVersionFor } from "./contract.js";
import { ecosystemFor } from "./ecosystem.js";
import { applyProfileOverlays, loadProfileEcosystem } from "./profiles.js";
import {
  assessOverrides,
  customisedNote,
  overrideReader,
  resolveOverrides,
  type Customisation,
  type OverrideSet,
} from "./profileoverrides.js";
import {
  branchTargetKey,
  prTargetKey,
  lastRound,
  loadState,
  openFindings,
  recordRound,
  saveState,
  type ReviewRound,
  type ReviewState,
} from "./reviewstate.js";
import { openReviewStoreIn } from "./reviewstore.js";
import { prepareReviewHost } from "./reviewhost.js";
import { postAssembled, type PostGithub, SAVED_POST_FILE, type SavedPost } from "./savedpost.js";
import type { ReviewTarget } from "./reviewtarget.js";

export { postSavedReview, SAVED_POST_FILE, type PostOutcome, type SavedPost } from "./savedpost.js";
export type { ReviewTarget } from "./reviewtarget.js";

/** Who is asking. "laptop" previews the price, asks above the limit (or, on
 * a model with no estimate, once) and stops hard at twice the estimate or at
 * the spend limit. "action" never asks and has no cap of its own: only a
 * given limit stops the run. */
export type ReviewRoute = "laptop" | "action";

/** What the host's isolation of one run is given: core's is
 * packages/pi-plugin/src/reviewhost.ts `prepareReviewHost`, which a host calls with its own words
 * for a refused login (`qcr review`'s: src/hostroute.ts `prepareHostRun`). */
export interface ReviewHostRequest {
  root: string;
  /** The operator's pi agent dir (its login). Read, never written. */
  srcAgentDir: string;
  /** Where the run's private agent dir goes: `<runDir>/agent`. */
  agentDir: string;
  /** The run's out dir: pi's cwd. */
  cwd: string;
  cfg: CoreConfig;
  /** The review's time budget: a login that expires inside it is refused
   * with `AuthExpiring` (packages/pi-plugin/src/engine/auth.ts). */
  needMs: number;
  /** Checkouts the cwd must stay out of: the asset tree, the reviewed repo. */
  checkouts: readonly string[];
  /** A profile's replacements for the lens agents. */
  profile: { readFile?: (path: string) => string; lookup: ProfileLookup };
}

/** The isolated run the host prepared. */
export interface ReviewHostRun {
  /** pi's agent dir for the run. It goes with the run. */
  agentDir: string;
  /** Where pi runs. */
  cwd: string;
  /** Context files above `cwd` that pi would load too. */
  strayContext: string[];
}

export interface ReviewLimits {
  route?: ReviewRoute;
  /** The limit for this run. With an estimate it is the estimate a review may
   * have without asking, over the repo's own (`auto_limit_usd`; the hard stop
   * stays twice the estimate). With none it is the stop itself, over the
   * repo's `unmeasured_limit_usd`, and naming it is the person's word that
   * the run may start. On the "action" route it is the hard stop. */
  limitUsd?: number;
  /** Start without asking (over the limit, or with no estimate), quoting the
   * key a preview showed. */
  key?: string;
  /** The round's wall clock. */
  timeoutMs: number;
}

/** The model a run is on, as its host resolved it
 * (packages/pi-plugin/src/modelroute.ts `resolveRoute`). */
export interface ReviewRouted {
  /** The route, or why there is none. */
  result: RouteResult;
  /** The providers pi has a usable credential for on this host: a spec the
   * config pins to a provider outside them runs on the one the route's rule
   * moves it to. */
  inventory: readonly ProviderInventory[];
  /** The remembered provider: it breaks a tie when such a spec moves. */
  prefer?: string;
  /** The stored logins the host left out as too short for this run: a spec
   * pinned to one of their providers is refused at the start, not moved. */
  skipped?: readonly SkippedLogin[];
  /** Whose words the model line and a refusal are said in. */
  surface: RouteSurface;
  /** What a refusal's words need beyond the refusal. */
  facts?: RefusalFacts;
  /** More lines for the preview, said under the model line (what `--model`
   * replaced, for one). */
  notes?: readonly string[];
}

/** A runtime for one run. `dispose`, when it has one, is called when the run
 * ends (packages/pi-plugin/src/engine/reviewsdk.ts disposes the hosts it built). */
export type ReviewRuntime = Runtime & { dispose?: () => Promise<void> | void };

/** What a run's runtime is built for. */
export interface ReviewRuntimeRequest {
  /** The run's own directory. */
  runDir: string;
}

export interface ReviewOptions {
  /** The repository (or a directory in it) the review stands in. A diff
   * needs none there: it is then only read for context. */
  repoDir: string;
  /** The asset tree: prompts/, extensions/, agents/ (packages/pi-plugin/src/assetroot.ts). */
  root: string;
  /** The operator's pi agent dir. Its login is only read. The remembered
   * model choice beside it (modelchoice.ts) is read for the models the person
   * agreed to run with no estimate, and gains one when they agree here. */
  agentDir: string;
  /** Where each run keeps its throwaway tree and its files. */
  runsDir: string;
  /** Where a dry-run install records the review it would have posted. */
  dryrunDir: string;
  /** The review home: each repo's delta history and saved destination
   * (packages/pi-plugin/src/reviewstore.ts). Null: nothing is remembered, so every run is a full
   * review and no destination is saved. */
  storeDir: string | null;
  config: CoreConfig;
  ecosystem: Ecosystem;
  /** Where profiles are looked up before the asset tree's examples. */
  profileHomes?: readonly ProfilePlace[];
  /** A security review asked for on this run (`/qcr-review --security`): the
   * whole security family is planned, never a lens the profile switched off.
   * Absent: the family rows come from the triggers and the profile alone.
   * A run with a request reviews the whole target, as `full` does: an earlier
   * review's state is neither shortcut nor delta base for it. */
  securityRequest?: SecurityRequest;
  /** Builds the runtime that hosts one run's review session. Called once per
   * run, when the round is about to start (a preview, a refusal or an
   * unchanged head builds none), and the runtime is disposed when the run
   * ends. A runtime carries the run's lens board and lens runner, so it hosts
   * one run at a time: a runtime still hosting another run is refused. */
  runtime: (run: ReviewRuntimeRequest) => ReviewRuntime;
  /** Resolves the model the run is on. Called at most once per run, after the
   * plan exists and before the price is shown (a refused target and an
   * unchanged head never ask); it may ask the person which provider to use.
   * A run whose route does not resolve previews with no model and is refused
   * at a start. Absent: the review says nothing of its model, and its
   * sessions run on whatever the config pins and the runtime resolves. */
  route?: () => Promise<ReviewRouted>;
  /** Isolates the run from the operator's pi home and every checkout.
   * Absent: core's isolation (packages/pi-plugin/src/reviewhost.ts) with the engine's words for
   * a refused login. */
  prepareHost?: (req: ReviewHostRequest) => ReviewHostRun;
  /** Runs the round inside interactive pi instead of on `runtime` (a debug
   * round: no live log, no cap, nothing posted, no destination asked). */
  debugRound?: (spec: RoundSpec) => Promise<OneShotResult>;
  /** The install's memory. Absent or null: the review runs without memory
   * and says so once. */
  memory?: ReviewMemoryPort | null;
  /** Where the result goes, for this run. Absent or empty: the repo's saved
   * default, else the person is asked (`io.choose`), else the fallback. */
  destinations?: readonly Destination[];
  /** Write the markdown report to this file (implies "file"); a relative path
   * is the repo dir's. */
  reportFile?: string;
  /** Review the whole target again, ignoring what an earlier review left. */
  full?: boolean;
  limits: ReviewLimits;
  /** The host-plugin contract the caller reads (`qcr --schema N`,
   * contract.ts). Absent: the code's own review schema. Contract 1 cannot say
   * "no estimate": a review it could not state is refused before anything
   * runs, and a run with no model route is refused in the login's words, a
   * preview included. */
  contract?: number;
  /** The GitHub credential sources and where GitHub is (a test seam). */
  github?: PostGithub;
}

/** What a prompt port is given beside its question: the run's stop, which
 * closes the question unanswered. */
export interface AskOptions {
  signal?: AbortSignal;
}

/** A finished PR review, offered for posting (`ReviewIo.offerPost`). */
export interface PostOffer {
  repo: string;
  pr: number;
  /** The review as the report renders it. */
  markdown: string;
  /** Findings in it the bot has not already posted on the PR. */
  findings: number;
  /** The install keeps dry_run on: a post is recorded, not sent. */
  dryRun: boolean;
}

/** The round that is about to start, for a UI to show while it runs. */
export interface ReviewStarted {
  /** The run's directory: the round's live log is under it (src/live/). */
  runDir: string;
  /** Where the round writes its files. */
  outDir: string;
  /** The round's session name (the live log's key). */
  sessionName: string;
  lenses: readonly string[];
  /** The estimate; null where the run has none (an unmeasured or unpriced
   * model). */
  estimateUsd: number | null;
  /** The hard stop in dollars; null: none. */
  capUsd: number | null;
}

/** The ports: everything that reaches a person. */
export interface ReviewIo {
  /** Ask a yes/no question. Null or absent: nobody to ask. A stop closes the
   * question: the run ends stopped, whatever the port answers. */
  confirm?: ((question: string, o?: AskOptions) => Promise<boolean>) | null;
  /** Ask the person to pick one option. Absent: not interactive, so the
   * destination question is never asked. A stop closes it, as for `confirm`. */
  choose?: (question: string, options: DestinationChoice[], o?: AskOptions) => Promise<Destination>;
  /** The run's own progress lines for a person (the preview before the run,
   * the memory notice). */
  progress?: (line: string) => void;
  /** Asked once a PR review has finished, when its destinations do not
   * already post it: post it now? Yes posts exactly as `pr` would have, one
   * comment-only review through the gate with the install's dry_run. Given
   * the review as a person reads it. Absent: nothing is offered. A stop
   * closes the question unanswered, and nothing is posted. */
  offerPost?: (offer: PostOffer, o?: AskOptions) => Promise<boolean>;
  /** The round is about to start: where it runs and what it plans. */
  started?: (run: ReviewStarted) => void;
  /** A warning said before the run. */
  warn?: (line: string) => void;
  /** The round's diagnostics. */
  log?: (line: string) => void;
  /** Stops the review: it returns a stopped result and cleans up after itself. */
  signal?: AbortSignal;
}

/** The versioned JSON object (`qcr review --json`): schemas/review-result.v2.json,
 * or version 1's projection of it for a caller that reads contract 1. */
export type ReviewData = Record<string, unknown> & { schema_version: number; ok: boolean };

export interface ReviewResult {
  /** The versioned JSON object, `schema_version` first. */
  data: ReviewData;
  /** The rendered review; null when the run made none (a refusal, a preview,
   * a review that did not finish). */
  markdown: string | null;
  /** What a terminal shows a person. */
  text: string;
  /** 0 done; 1 refused, declined, failed, stopped or partial; 2 usage. */
  exitCode: 0 | 1 | 2;
  /** Where the result goes, as settled; null when the run ended before that
   * (the caller's own fallback applies). */
  destinations: readonly Destination[] | null;
}

const credentialLabel = (s: CredentialSource): string =>
  s === "app"
    ? "the GitHub App"
    : s === "handoff"
      ? "the token handed to the container"
      : s === "gh"
        ? "gh auth login"
        : s.slice("env:".length);

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** A credential as the preview carries it: what kind it is and where pi found
 * it. Never a value, and never the label of an environment source. */
const credentialData = (c: ProviderCredential): Record<string, unknown> => ({
  kind: c.kind,
  origin: c.origin,
  subscription: c.subscription,
});

/** The route as the preview's `model` object. */
function modelData(route: ModelRoute): Record<string, unknown> {
  return {
    spec: route.spec,
    provider: route.provider,
    id: route.modelId,
    provider_name: route.providerName,
    source: route.source,
    pick: route.pick,
    pi_default: route.piDefaultId,
    custom: route.custom,
    moved_from: route.movedFrom,
    priced: route.priced,
    ask: route.ask,
    credential: credentialData(route.credential),
  };
}

/** The other usable providers as the preview's `alternatives`. */
function alternativesData(route: ModelRoute): Record<string, unknown>[] {
  return route.alternatives.map((a) => ({
    spec: a.spec,
    provider: a.provider,
    provider_name: a.providerName,
    priced: a.priced,
    credential: credentialData(a.credential),
  }));
}

/** The preview's lines about the model: the route's one line (which model,
 * why, and how to change it) with the route's own notices under it, or that
 * there is none and why; then the host's notes. */
function modelLines(routed: ReviewRouted): string[] {
  const head = routed.result.ok
    ? routeNoticeLines(routed.result.route, routed.surface)
    : [
        `model: none (${
          routed.result.refusal.code === "no-credential"
            ? `no model credential: ${routed.surface === "plugin" ? "/login" : "qcr login"}`
            : new RouteRefused(routed.result.refusal).message
        })`,
      ];
  return [...head, ...(routed.notes ?? [])].map((l) => `  ${l}`);
}

/** An unfinished review's raw record, less the findings the bot already posted. */
function rawWithout(record: unknown, posted: readonly PostedFinding[]): unknown {
  const list = (record as { findings?: unknown } | null | undefined)?.findings;
  if (posted.length === 0 || !Array.isArray(list)) return record;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const kept = skipPosted(
    list.map((e: unknown) => {
      // a malformed entry (null, a bare string) is kept as it is, as the other readers keep it
      const o = typeof e === "object" && e !== null ? (e as Record<string, unknown>) : {};
      return {
        e,
        key: str(o["id"]) ?? str(o["key"]),
        path: str(o["path"]),
        title: str(o["title"]),
        line: typeof o["line"] === "number" ? o["line"] : null,
      };
    }),
    posted,
  ).fresh.map((x) => x.e);
  return { ...(record as object), findings: kept };
}

/** A finding an earlier review raised that no review has resolved. */
interface StillOpen {
  path: string | null;
  line: number | null;
  severity: string | null;
  title: string;
  lens: string | null;
  /** The head that review was of. */
  head_sha: string;
}

function renderStillOpen(open: readonly StillOpen[]): string[] {
  if (open.length === 0) return [];
  return [
    "",
    `Still open from earlier reviews (${open.length})`,
    ...open.map((f) => {
      const where = f.path ? `${f.path}${f.line !== null ? `:${f.line}` : ""}` : "(no location)";
      return `  ${where}  ${f.severity ? `[${f.severity}] ` : ""}${f.title}`;
    }),
  ];
}

/** A cleanup that removes `dir` when the run left nothing in it (a preview,
 * a refusal), and keeps it otherwise. */
function removeIfEmpty(dir: string): () => void {
  return () => {
    try {
      rmdirSync(dir);
    } catch {
      // not empty, or never made: either way it stays as it is
    }
  };
}

/** The report a no-review shortcut writes when a file was asked for: the same
 * words the terminal gets, so a report file is never left unwritten. */
function shortcutMarkdown(title: string, lines: readonly string[]): string {
  return `# ${title}\n\n${lines.join("\n")}\n`;
}

/** Why a re-review is a full one, in words. */
function fallbackWords(reason: string): string {
  switch (reason) {
    case "history-rewritten":
      return "the branch was rewritten since the last reviewed head";
    case "delta-too-large":
      return "the change since the last review is too large to treat as a follow-up";
    case "follow_up_full":
      return "follow-up reviews are off in this repo's config";
    default:
      return `the change since the last review could not be trusted (${reason})`;
  }
}

/** The lenses that started, from the run's stage record. */
function startedLenses(outDir: string): string[] {
  try {
    const stages = JSON.parse(readFileSync(join(outDir, "stages.json"), "utf8")) as {
      calls?: Array<{ agents?: string[]; kind?: string }>;
    };
    return [
      ...new Set(
        (stages.calls ?? []).filter((c) => c.kind === "lens").flatMap((c) => c.agents ?? []),
      ),
    ];
  } catch {
    return [];
  }
}

const STOPPED = "the review was stopped";

/** A port's answer, or `STOP` once the signal fires first: a prompt that does
 * not hear the signal never holds a stopped run. */
const STOP: unique symbol = Symbol("stop");
function unlessStopped<T>(
  signal: AbortSignal | undefined,
  ask: (o: AskOptions) => Promise<T>,
): Promise<T | typeof STOP> {
  if (signal === undefined) return ask({});
  if (signal.aborted) return Promise.resolve(STOP);
  let onAbort: () => void = () => {};
  const stopped = new Promise<typeof STOP>((done) => {
    onAbort = () => done(STOP);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([ask({ signal }), stopped]).finally(() =>
    signal.removeEventListener("abort", onAbort),
  );
}

/** The runtimes hosting a run now: one runtime never hosts two at once. */
const hosting = new WeakSet<Runtime>();

/** Run the review of `target`: the plan, the price, the round, the record and,
 * when asked, the post. Never throws for a refusal; the result says it. */
export function review(
  target: ReviewTarget,
  opts: ReviewOptions,
  io: ReviewIo = {},
): Promise<ReviewResult> {
  return withCleanups((cleanups) => runPipeline(target, opts, io, "review", cleanups));
}

/** The plan, the price and the key `review` would run under; starts nothing,
 * asks nothing and saves no destination. */
export function preview(
  target: ReviewTarget,
  opts: ReviewOptions,
  io: ReviewIo = {},
): Promise<ReviewResult> {
  return withCleanups((cleanups) => runPipeline(target, opts, io, "preview", cleanups));
}

/** What the run leaves to undo, newest first when it ends. */
type Cleanups = Array<() => void | Promise<void>>;

async function withCleanups(
  run: (cleanups: Cleanups) => Promise<ReviewResult>,
): Promise<ReviewResult> {
  const cleanups: Cleanups = [];
  try {
    return await run(cleanups);
  } finally {
    for (const c of cleanups.reverse()) {
      try {
        await c();
      } catch {
        // a scratch tree that will not go is the OS temp cleaner's
      }
    }
  }
}

async function runPipeline(
  target: ReviewTarget,
  opts: ReviewOptions,
  io: ReviewIo,
  mode: "review" | "preview",
  cleanups: Cleanups,
): Promise<ReviewResult> {
  const isPreview = mode === "preview";
  const debug = opts.debugRound !== undefined && !isPreview;
  // Contract 1 reads an estimate that is always a number.
  const needsEstimate = reviewVersionFor(opts.contract) === 1;
  // Whose words a refusal is said in: the host's, once it has resolved a route.
  let routed: ReviewRouted | null = null;
  const surfaceOf = (): RouteSurface => routed?.surface ?? "app";
  const warn = io.warn ?? (() => {});
  const progress = io.progress ?? (() => {});
  const repoDir = opts.repoDir;
  // Where results go: null until settled (the flags, the saved default, the
  // person's pick); until then the caller's own fallback applies.
  let dests: readonly Destination[] | null = null;
  const sends = (d: Destination): boolean => (dests ?? FALLBACK_DESTINATIONS).includes(d);
  let reportPath: string | null = null;
  const finish = (
    exitCode: 0 | 1 | 2,
    human: string,
    data: Record<string, unknown>,
    markdown?: string,
  ): ReviewResult => {
    if (markdown !== undefined && sends("file") && reportPath !== null) {
      try {
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, markdown);
        human += `\nReport: ${reportPath}`;
        data = { ...data, report: reportPath };
      } catch (err) {
        // The requested report could not be written: the run is not a success.
        exitCode = 1;
        human += `\nThe report could not be written: ${String(err).slice(0, 200)}`;
        data = { ...data, ok: false, report_error: String(err).slice(0, 200) };
      }
    }
    // Stamped for the caller's contract. A payload contract 1 cannot carry
    // never leaves under it: the refusal does, in its place.
    const stamped = reviewForContract(opts.contract, data, surfaceOf());
    if (stamped.refused !== null)
      return {
        data: stamped.data as ReviewData,
        markdown: null,
        text: `✗ ${stamped.refused}`,
        exitCode: 1,
        destinations: dests,
      };
    return {
      data: stamped.data as ReviewData,
      markdown: markdown ?? null,
      text: human,
      exitCode,
      destinations: dests,
    };
  };
  const refuse = (code: 1 | 2, errors: string[]): ReviewResult =>
    finish(code, errors.map((e) => `✗ ${e}`).join("\n"), { ok: false, errors });
  const stopped = (): ReviewResult =>
    finish(1, `✗ ${STOPPED}`, { ok: false, stopped: true, errors: [STOPPED] });
  if (io.signal?.aborted) return stopped();

  const explicit: Destination[] = [
    ...(opts.destinations ?? []),
    ...(opts.reportFile !== undefined ? (["file"] as const) : []),
  ].filter((d, i, a) => a.indexOf(d) === i);
  // Posting needs a PR: asked for on any other target, it is refused before
  // anything runs or is paid for.
  if (explicit.includes("pr") && target.kind === "diff")
    return refuse(2, [
      "--to pr posts to a pull request, and a diff has no PR: the findings go to the terminal, a file or json",
    ]);
  if (explicit.includes("pr") && target.kind !== "pr")
    return refuse(2, [
      "--to pr posts to a pull request, and this target has no PR: pass a PR number or URL",
    ]);
  if (explicit.includes("pr") && debug)
    return refuse(2, ["a debug round posts nothing: drop --to pr"]);
  // A saved default that posts does not apply to a target with no PR. A debug
  // round posts nothing, so it neither reads the saved default nor asks.
  const savedAll =
    explicit.length > 0 || debug ? null : loadDefaultDestinationsIn(opts.storeDir, repoDir);
  const savedUse =
    savedAll === null || target.kind === "pr" ? savedAll : savedAll.filter((d) => d !== "pr");
  const saved = savedUse !== null && savedUse.length > 0 ? savedUse : null;
  if (explicit.length > 0) dests = explicit;
  else if (saved !== null) dests = saved;
  else if (io.choose || debug) dests = ["terminal"];
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
  // Where git commands run: the checkout the person stands in, or for a PR
  // the scratch repository its head and base were fetched into.
  let gitDir = repoDir;
  let t: BranchTarget;
  let prInfo: {
    number: number;
    title: string;
    body: string | null;
    source: CredentialSource;
    repo: string;
    token: string;
  } | null = null;
  let runDir: string;
  let prToken = "";
  const gh = opts.github;
  if (target.kind === "pr") {
    const parsed = parsePrTarget(String(target.pr), {
      cwdRepo: originRepo(repoDir),
      ...(target.repo !== undefined ? { repo: target.repo } : {}),
    });
    if (!parsed.ok) return refuse(1, [parsed.error]);
    const cred = await resolvePrCredential(opts.config.github.secrets_dir, gh);
    if (!cred.ok) return refuse(1, [cred.error]);
    if (io.signal?.aborted) return stopped();
    runDir = join(opts.runsDir, `${stamp}-pr${parsed.number}`);
    cleanups.push(removeIfEmpty(runDir));
    const scratch = join(runDir, "repo");
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const fetched = await fetchPrTarget({
      repo: parsed.repo,
      number: parsed.number,
      scratchDir: scratch,
      token: cred.token,
      ...(gh?.fetchFn ? { fetchFn: gh.fetchFn } : {}),
      ...(gh?.gitBase ? { gitBase: gh.gitBase } : {}),
      ...(gh?.apiBase ? { apiBase: gh.apiBase } : {}),
      ...(io.signal ? { signal: io.signal } : {}),
    });
    if (!fetched.ok) return io.signal?.aborted ? stopped() : refuse(1, [fetched.error]);
    gitDir = fetched.gitDir;
    prToken = cred.token;
    t = fetched.target;
    prInfo = {
      number: fetched.number,
      title: fetched.title,
      body: fetched.body,
      source: cred.source,
      repo: parsed.repo,
      token: cred.token,
    };
  } else {
    let resolved: ReturnType<typeof resolveBranch>;
    if (target.kind === "diff") {
      let text: string;
      try {
        text = typeof target.diff === "string" ? target.diff : await target.diff();
      } catch (err) {
        return refuse(1, [err instanceof Error ? err.message : String(err)]);
      }
      resolved = resolveDiff(repoDir, text);
    } else
      resolved =
        target.kind === "uncommitted"
          ? resolveUncommitted(repoDir, { scratchParent: opts.runsDir })
          : resolveBranch(repoDir, target.base, {
              ...(target.head !== undefined ? { head: target.head } : {}),
              ...(target.uncommitted ? { uncommitted: true, scratchParent: opts.runsDir } : {}),
            });
    if (!resolved.ok) return refuse(1, [resolved.error]);
    t = resolved.target;
    runDir = join(opts.runsDir, `${stamp}-${t.headSha.slice(0, 7)}`);
    cleanups.push(removeIfEmpty(runDir));
  }
  // Resolving the target can take a while (a PR's fetch): a stop that came
  // meanwhile ends a preview as well as a review here.
  if (io.signal?.aborted) return stopped();
  // The first interactive run in a repo asks where results go and keeps the
  // answer for it; a run with no terminal and no default never waits. The
  // answer comes before anything reads the destinations (posting to a PR
  // changes what is reviewed), and a preview, which starts nothing, never asks.
  if (explicit.length === 0 && saved === null && io.choose && !isPreview && !debug) {
    const choose = io.choose;
    const picked = await unlessStopped(io.signal, (o) =>
      choose("Where should review results go?", destinationChoices({ pr: prInfo !== null }), o),
    );
    if (picked === STOP || io.signal?.aborted) return stopped();
    dests = [picked];
    saveDefaultDestinationsIn(opts.storeDir, repoDir, dests);
  }
  if (sends("file"))
    reportPath =
      opts.reportFile !== undefined ? resolve(repoDir, opts.reportFile) : join(runDir, "report.md");
  const diffName = target.kind === "diff" ? (target.name ?? "-") : undefined;
  const label = prInfo
    ? `PR #${prInfo.number} against ${t.base}`
    : diffName !== undefined
      ? diffName === "-"
        ? "the piped diff"
        : `the diff ${diffName}`
      : target.kind === "uncommitted"
        ? `uncommitted changes on ${t.branch}`
        : `${t.branch} against ${t.base}${t.uncommitted ? ", with its uncommitted changes" : ""}`;
  const kind: "pr" | "branch" | "uncommitted" | "diff" = target.kind;
  // what the markdown report is titled
  const subject =
    kind === "diff"
      ? label
      : `${t.branch} against ${t.base}${kind === "branch" && t.uncommitted ? ", with its uncommitted changes" : ""}`;
  const settings = loadReviewSettings(repoDir);
  const action = (opts.limits.route ?? "laptop") === "action";

  // What an earlier review of this target left (none with `full`, or when it
  // cannot be trusted).
  // A branch and a PR each keep state under their own key (the PR's delta is
  // computed in its scratch repository); the uncommitted tree, a branch with
  // uncommitted edits on top and a diff keep none.
  // A run that posts to a PR reviews in full: the findings already on the PR
  // (the posted-findings skip) are its repeat protection, and an
  // unchanged-head shortcut would also skip the post. A security review asked
  // for on this run reviews in full too: the earlier review it would build on
  // ran no security family, so neither "nothing new" nor a follow-up over the
  // change since it answers the request.
  const targetKey = prInfo
    ? prTargetKey(prInfo.repo, prInfo.number)
    : branchTargetKey(t.repo, t.branch);
  const keepsState = (kind === "branch" && t.uncommitted === undefined) || kind === "pr";
  const statePath =
    opts.storeDir === null
      ? null
      : (openReviewStoreIn(opts.storeDir, repoDir)?.statePath(targetKey) ?? null);
  const postsToPr = prInfo !== null && sends("pr");
  const prev =
    opts.full || opts.securityRequest !== undefined || !keepsState || postsToPr
      ? null
      : loadState(statePath, targetKey);
  const short = (sha: string): string => sha.slice(0, 7);
  const stillOpen = (s: ReviewState | null, before?: number): StillOpen[] =>
    openFindings(s)
      .findings.filter((f) => before === undefined || f.round_no < before)
      .map((f) => ({
        path: f.path,
        line: f.line,
        severity: f.severity,
        title: f.title ?? "(untitled finding)",
        lens: f.lens || null,
        head_sha: f.head_sha,
      }));

  // An unchanged head: nothing to review, nothing to pay.
  if (prev !== null) {
    const last = lastRound(prev);
    if (last.head_sha === t.headSha && last.merge_base === t.mergeBase) {
      const open = stillOpen(prev);
      const lines = [
        `Nothing new: ${t.branch} is unchanged since the review at ${short(last.head_sha)} (${last.reviewed_at.slice(0, 10)}). Spent ${usd(0)}.`,
        ...renderStillOpen(open),
      ];
      return finish(
        0,
        [...lines, "Pass --full to review the whole branch again."].join("\n"),
        {
          ok: true,
          unchanged: true,
          head_sha: t.headSha,
          reviewed_at: last.reviewed_at,
          cost_usd: 0,
          still_open: open,
        },
        shortcutMarkdown(`Review of ${t.branch} against ${t.base} (${t.repo})`, lines),
      );
    }
  }

  // The change since the last reviewed head, when it can be trusted.
  let delta: DeltaFound | null = null;
  let fallback: { reason: string; detail?: string } | null = null;
  if (prev !== null) {
    if (!deltaEnabled(opts.config)) fallback = { reason: "follow_up_full" };
    else {
      // a PR's commits live in its scratch repository, not in the person's checkout
      const d = await computeDelta(gitDir, prev, t);
      if (d.ok) delta = d.delta;
      else fallback = { reason: d.reason, ...(d.detail ? { detail: d.detail } : {}) };
    }
  }
  // Nothing of the author's own changed (a clean merge of the base only): the
  // earlier review still stands for the new head.
  if (prev !== null && delta !== null && delta.files.length === 0) {
    const last = lastRound(prev);
    const moved: ReviewState = {
      ...prev,
      rounds: [
        ...prev.rounds.slice(0, -1),
        { ...last, head_sha: t.headSha, base_sha: t.baseSha, merge_base: t.mergeBase },
      ],
    };
    if (!isPreview) saveState(statePath, moved);
    const open = stillOpen(prev);
    const lines = [
      `Nothing new: ${t.branch} moved from ${short(last.head_sha)} to ${short(t.headSha)}, but none of its own changes did. Spent ${usd(0)}.`,
      ...renderStillOpen(open),
    ];
    return finish(
      0,
      lines.join("\n"),
      { ok: true, unchanged: true, head_sha: t.headSha, cost_usd: 0, still_open: open },
      shortcutMarkdown(`Review of ${t.branch} against ${t.base} (${t.repo})`, lines),
    );
  }

  const outDir = join(runDir, "out");
  const treeDir = join(runDir, "tree");
  // The profiles' replacements of shipped agents and prompts
  // (packages/pi-plugin/src/profileoverrides.ts): the repo's `.qcr/` as the BASE commit has it,
  // under the user's named profile. The gate (`dry_run`), the credentials and
  // the bash guard stay the options' own; only lens tuning, the ecosystem,
  // agents and prompts move.
  let overrides: OverrideSet;
  let custom: Customisation;
  let cfg: CoreConfig;
  let ecosystem: Ecosystem;
  cleanups.push(() => rmSync(join(runDir, "profile"), { recursive: true, force: true }));
  try {
    overrides = resolveOverrides({
      root: opts.root,
      profile: opts.config.review.profile,
      lookup: { homes: opts.profileHomes ?? [] },
      repo: { gitDir, baseRef: t.baseSha, destDir: join(runDir, "profile") },
    });
    custom = assessOverrides(opts.root, overrides);
    // The same base-branch `.qcr/profile.toml` feeds the lens tuning and the
    // ecosystem; a bad value there is the profile's fault, not a crash.
    if (overrides.lookup.repoProfile !== undefined) {
      cfg = applyProfileOverlays(opts.root, opts.config, overrides.lookup);
      ecosystem = ecosystemFor(
        loadProfileEcosystem(opts.root, opts.config.review.profile, overrides.lookup),
      );
    } else {
      cfg = opts.config;
      ecosystem = opts.ecosystem;
    }
  } catch (err) {
    return refuse(1, [`the profile could not be loaded: ${String(err).slice(0, 300)}`]);
  }
  const readFile = overrideReader(opts.root, overrides);
  const profileLookup = overrides.lookup;
  const profileArgs = { ...(readFile ? { readFile } : {}), profileLookup };
  // What the security family reads beyond the files, as dispatch reads it:
  // the repository's `.qcr/threat-model.md` at the base commit (read with
  // the repo profile above; it wins over the profile's copy), and the
  // deterministic facts over the reviewed commits — the ones that can plan a
  // lens now, the route inventory only for a round that plans a family row.
  // A diff has no commit to read, so only its diff-only checks run. Nothing
  // is read when every family lens is off.
  const repoThreatModel = overrides.repoThreatModel;
  const familyOn = SECURITY_FAMILY.some((lens) => lensEnabled(cfg.lenses, lens));
  // An uncommitted target's snapshot tree is not readable once resolved (its
  // object store is gone): its head is the working tree it was taken from.
  const factsIo =
    kind === "diff"
      ? null
      : t.uncommitted !== undefined
        ? workTreeFactsIo(gitDir, t.baseSha)
        : localGitFactsIo(gitDir, { head: t.headSha, base: t.baseSha });
  let inventory: readonly SecurityFact[] | undefined;
  const securityArgs = familyOn
    ? {
        readRepoThreatModel: () => repoThreatModel,
        securityFacts: computeSecurityFacts(t.files, factsIo, SECURITY_TRIGGER_CHECKS),
        securityInventory: () =>
          (inventory ??= computeSecurityFacts(t.files, factsIo, ["route-inventory"])),
      }
    : { readRepoThreatModel: () => repoThreatModel };
  const roundTarget = {
    repo: t.repo,
    number: prInfo?.number ?? 0,
    title: prInfo?.title ?? label,
    body: prInfo?.body ?? null,
    headSha: t.headSha,
    baseRef: t.base,
    baseSha: t.baseSha,
    mergeBase: t.mergeBase,
  };
  // The plan: the production round order's lens plan for this diff — the
  // follow-up plan over the delta when there is one, else the full plan. Pure;
  // the checkout the person is standing in is only read.
  const planRound = (
    tree: string,
    memory?: RoundMemory,
    target: typeof roundTarget = roundTarget,
  ): { prompts: OneShotPrompts; scope: "delta" | "full"; fallback: typeof fallback } => {
    const common = {
      root: opts.root,
      cfg,
      ecosystem,
      target,
      tree,
      caseDir: outDir,
      files: t.files,
      issuedAt: new Date().toISOString(),
      ...profileArgs,
      ...securityArgs,
      ...(opts.securityRequest ? { securityRequest: opts.securityRequest } : {}),
    };
    let why = fallback;
    if (prev !== null && delta !== null) {
      const fu = renderDeltaRound({ ...common, state: prev, delta, ...(memory ? { memory } : {}) });
      if (fu.followUp.scope === "delta") return { prompts: fu, scope: "delta", fallback: null };
      why = { reason: fu.followUp.reason ?? "follow-up-full" };
    }
    return {
      prompts: renderOneShotPrompts(memory ? { ...common, memory } : common),
      scope: "full",
      fallback: why,
    };
  };
  let planned: ReturnType<typeof planRound>;
  try {
    // a diff has no checkout to plan over: a scratch tree built the way the
    // review tree is (HEAD plus the diff) stands in, so the plan the person
    // authorizes is the one the run executes. Its warning is the run tree's.
    let planTree = gitDir;
    if (kind === "diff") {
      mkdirSync(runDir, { recursive: true });
      planTree = mkdtempSync(join(runDir, "plan-"));
      const scratch = planTree;
      cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
      addDiffTree(repoDir, scratch, t);
    }
    planned = planRound(planTree);
  } catch (err) {
    return refuse(1, [`the review plan could not be built: ${String(err).slice(0, 300)}`]);
  }
  const lenses = planned.prompts.plannedLenses;
  const scope = planned.scope;
  fallback = planned.fallback;
  // The model the run is on: the host's to resolve, now that there is a plan
  // to run. A preview with no route still shows the plan; a start is refused
  // in the route's own words, before anything is priced or asked. So is a
  // preview for a caller on contract 1, which has no way to say "no model".
  if (opts.route !== undefined) {
    const resolveRoute = opts.route;
    let got: ReviewRouted | typeof STOP;
    try {
      got = await unlessStopped(io.signal, () => resolveRoute());
    } catch (err) {
      return refuse(1, [
        err instanceof AuthError
          ? err.message
          : `the review's model could not be resolved: ${String(err).slice(0, 300)}`,
      ]);
    }
    if (got === STOP || io.signal?.aborted) return stopped();
    routed = got;
    if (!routed.result.ok && (!isPreview || needsEstimate))
      return refuse(1, [refusalText(routed.result.refusal, routed.surface, routed.facts)]);
  }
  const route = routed !== null && routed.result.ok ? routed.result.route : null;
  const on: RunRoute | null =
    routed === null
      ? null
      : {
          route,
          inventory: routed.inventory,
          ...(routed.prefer !== undefined ? { prefer: routed.prefer } : {}),
          ...(routed.skipped !== undefined ? { skipped: routed.skipped } : {}),
        };
  // Every spec the run will use, as it will run: with no route given they
  // are the config's own, so a changed pin still moves the key.
  const models = runModels(cfg, lenses, on);
  const since = scope === "delta" && prev !== null ? lastRound(prev).head_sha : undefined;
  const priceLines = scope === "delta" && delta !== null ? delta.lines : t.lines;
  // A tier or a lens the config pins to a provider whose login was left out
  // as too short would fail when its session is opened: the run is refused
  // before anything starts, and the preview says so.
  const tooShort = tooShortFor(models.all, on);
  const pinRefusal =
    tooShort.length > 0 && routed !== null
      ? refusalText({ code: "login-too-short", logins: tooShort }, routed.surface, routed.facts)
      : null;
  if (pinRefusal !== null && (!isPreview || needsEstimate)) return refuse(1, [pinRefusal]);

  // The price: what it is known from decides the line, the stop and the question.
  const rates = repoRates(settings);
  const basis: PriceBasis = priceBasis({
    route: routed === null ? undefined : route,
    repoRates: rates !== null,
    specs: models.all,
    inventory: routed?.inventory ?? [],
  });
  // What the price lines call the model: the route's spec, else the one the
  // config pins for the main session.
  const priceSpec = route?.spec ?? splitModelSpec(models.main).model;
  const named = priceSpec !== "" ? priceSpec : "this model";
  // pi counts no cost for a model it has no price for, so no dollar figure
  // can stop a run on one, whatever estimate the repo's own rates give.
  const noDollarStop = basis === "unpriced" || (route !== null && !route.priced);
  const price: number | null =
    basis === "measured" || basis === "repo"
      ? priceReview(lenses.length, priceLines, rates ?? MEASURED)
      : null;
  const given = opts.limits.limitUsd;
  // `limit`: with an estimate, the estimate a review may have without asking
  // (the person's, or this run's); with none, the stop itself. The Action has
  // no limit of its own: only one given for the run applies, as its hard stop.
  let limit: number | null;
  let cap: number | null;
  let auto: boolean;
  if (basis === "unknown") {
    limit = null;
    cap = null;
    auto = false;
  } else if (price !== null) {
    limit = action ? (noDollarStop ? null : (given ?? null)) : (given ?? settings.auto_limit_usd);
    cap = noDollarStop ? null : action ? limit : hardStopFor(price);
    auto = action || limit === null || price <= limit;
  } else if (basis === "unpriced") {
    limit = null;
    cap = null;
    auto = true;
  } else {
    limit = action ? (given ?? null) : (given ?? settings.unmeasured_limit_usd);
    cap = limit;
    // The person's word, given once: the stop named on this run, or the model
    // among those they agreed to run with no estimate.
    auto =
      action ||
      given !== undefined ||
      (priceSpec !== "" && readModelChoice(opts.agentDir).noEstimateOk.includes(priceSpec));
  }
  // A limit that can stop nothing is said to be ignored, never silently dropped.
  const limitIgnored = given !== undefined && noDollarStop && (price === null || action);
  // Contract 1 cannot say "no estimate": refused here, before anything runs.
  if (needsEstimate && price === null)
    return refuse(1, [contractOneNoPrice(priceSpec, measuredSpec(routed?.inventory ?? []))]);
  const key = reviewKey({
    // an uncommitted review is keyed on the edits, so the key moves with them
    headSha: t.uncommitted?.treeSha ?? t.headSha,
    baseSha: t.baseSha,
    lenses,
    lines: priceLines,
    cap_usd: cap ?? 0,
    models: models.all,
    ...(since !== undefined ? { since } : {}),
  });
  const priorCount = scope === "delta" ? openFindings(prev).findings.length : 0;
  const previewData = {
    repo: t.repo,
    target: { kind, ...(kind === "branch" && t.uncommitted ? { uncommitted: true } : {}) },
    // posting is offered only when a PR is behind the target
    postable: prInfo !== null,
    ...(kind === "diff" ? {} : { branch: t.branch }),
    base: t.base,
    head_sha: t.headSha,
    files: scope === "delta" && delta !== null ? delta.files.length : t.files.length,
    lines: priceLines,
    scope,
    ...(since !== undefined ? { since, prior_open: priorCount } : {}),
    ...(fallback !== null ? { fallback_reason: fallback.reason } : {}),
    lenses,
    // The model: null says no route resolves, or that the host named none.
    model: route !== null ? modelData(route) : null,
    alternatives: route !== null ? alternativesData(route) : [],
    tiers: models.tiers,
    // A pinned tier or lens that cannot run here: a start is refused with it.
    ...(pinRefusal !== null ? { refusal: { code: "login-too-short", text: pinRefusal } } : {}),
    price_basis: basis,
    estimate_usd: price,
    cap_usd: cap,
    limit_usd: limit,
    auto: auto && pinRefusal === null,
    key,
    ...(prInfo ? { pr: prInfo.number, credential: prInfo.source } : {}),
  };
  const minutes = Math.round(opts.limits.timeoutMs / 60_000);
  const stillHolds = `the ${minutes}-minute limit still holds`;
  const estimateWords =
    basis === "repo" ? "estimate, this repo's rates" : `estimate, measured on ${MEASURED.model_id}`;
  let priceLine: string;
  if (basis === "unknown") priceLine = "price: unknown until a model credential exists";
  else if (price !== null)
    priceLine =
      `price: ${usd(price)} (${estimateWords}) — ` +
      (noDollarStop
        ? `pi has no price for ${named}, so no dollar stop; ${stillHolds}`
        : cap === null
          ? "no cap"
          : `the run stops hard at ${usd(cap)}`) +
      (action || limit === null ? "" : ` (limit without asking: ${usd(limit)})`);
  else if (basis === "unpriced")
    priceLine = `price: pi has no price for ${named} — no dollar stop; ${stillHolds}`;
  else
    priceLine =
      `price: no estimate for ${named} (not measured) — ` +
      (cap === null ? "no cap" : `the run stops at ${usd(cap)}`);
  const previewText = [
    `Review ${label} (${t.repo})`,
    scope === "delta"
      ? `  delta since ${short(since!)}: ${previewData.files} file${previewData.files === 1 ? "" : "s"}, ${priceLines} changed line${priceLines === 1 ? "" : "s"}; ${priorCount} earlier finding${priorCount === 1 ? "" : "s"} to verify`
      : `  ${t.files.length} file${t.files.length === 1 ? "" : "s"}, ${t.lines} changed line${t.lines === 1 ? "" : "s"}` +
        (fallback !== null ? ` — full review, not a delta: ${fallbackWords(fallback.reason)}` : ""),
    `  lenses: ${lenses.join(", ")}`,
    // The run's notice about its model: said here, once.
    ...(routed !== null ? modelLines(routed) : []),
    ...(pinRefusal !== null ? [`  ✗ ${pinRefusal}`] : []),
    `  ${priceLine}`,
    // A subscription is not billed per review: the dollars are list prices.
    ...(route !== null && route.credential.subscription && basis !== "unpriced"
      ? [`  list prices: your ${route.providerName} plan is not billed per review`]
      : []),
    ...(limitIgnored ? [`  --limit ignored: pi has no price for ${named}`] : []),
    `  key: ${key}`,
    ...(prInfo ? [`  GitHub credential: ${credentialLabel(prInfo.source)}`] : []),
    ...(custom.customised ? [`  ${customisedNote(custom)}`] : []),
  ];
  if (isPreview) return finish(0, previewText.join("\n"), { ok: true, preview: previewData });
  for (const l of previewText) progress(l);

  // The run starts on the person's say: at once when nothing needs it, else
  // on the key a preview showed, or a yes at the terminal.
  if (!auto) {
    const asked = opts.limits.key;
    // No estimate: the question is asked once per model, and a yes (or the
    // key, which a host sends after the person agreed) is remembered.
    const remember = (): void => {
      if (price !== null || priceSpec === "") return;
      const kept = allowNoEstimate(opts.agentDir, priceSpec);
      // An answer that cannot be kept still holds for this run.
      if (!kept.ok) warn(kept.error);
    };
    if (asked !== undefined) {
      if (asked !== key)
        return refuse(1, [
          `--key ${asked} does not match this review (the branch, plan or price changed): preview again`,
        ]);
      remember();
    } else if (!io.confirm) {
      return refuse(1, [
        price === null
          ? `no estimate for ${named} and no terminal to ask: qcr review --key ${key}, or name the stop with --limit`
          : `the price ${usd(price)} is over the limit ${usd(limit!)} and there is no terminal to ask: ` +
            `qcr review --key ${key}`,
      ]);
    } else {
      const confirm = io.confirm;
      const question =
        price === null
          ? `Run on ${named} with no estimate? It stops at ${usd(cap!)}. (Reviews on this model will not ask again.)`
          : `Run for ${usd(price)}, over the ${usd(limit!)} limit?`;
      const yes = await unlessStopped(io.signal, (o) => confirm(question, o));
      if (yes === STOP || io.signal?.aborted) return stopped();
      if (!yes)
        return refuse(1, [
          price === null
            ? `declined: no estimate for ${named}`
            : `declined: ${usd(price)} is over the ${usd(limit!)} limit`,
        ]);
      remember();
    }
  }
  if (io.signal?.aborted) return stopped();

  // The run's own runtime: built now, disposed when the run ends.
  let runtime: ReviewRuntime | null = null;
  if (!debug) {
    try {
      runtime = opts.runtime({ runDir });
    } catch (err) {
      return refuse(1, [`the review's runtime could not be built: ${String(err).slice(0, 300)}`]);
    }
    if (hosting.has(runtime))
      return refuse(1, [
        "the runtime is already hosting another review: a runtime hosts one run at a time, so ReviewOptions.runtime builds one per run",
      ]);
    const rt = runtime;
    hosting.add(rt);
    cleanups.push(async () => {
      hosting.delete(rt);
      await rt.dispose?.();
    });
  }

  mkdirSync(runDir, { recursive: true });
  const runWarnings: string[] = overrides.ignored.map((l) => `profile: ${l}`);
  // pi runs isolated from the operator's pi home, the asset tree and the
  // reviewed repo: a private agent dir and, as its cwd, the run's out dir
  // holding the reviewer stub (the host's `prepareHost`).
  let host: ReviewHostRun;
  try {
    host = (opts.prepareHost ?? prepareReviewHost)({
      root: opts.root,
      srcAgentDir: opts.agentDir,
      agentDir: join(runDir, "agent"),
      cwd: outDir,
      cfg,
      needMs: opts.limits.timeoutMs,
      checkouts: [repoDir, gitDir],
      profile: {
        ...(readFile ? { readFile } : {}),
        lookup: profileLookup,
      },
    });
  } catch (err) {
    return refuse(1, [
      err instanceof AuthExpiring
        ? err.message
        : `the review could not be isolated: ${String(err).slice(0, 300)}`,
    ]);
  }
  // The private agent dir holds a copy of the login: it goes with the run.
  cleanups.push(() => rmSync(host.agentDir, { recursive: true, force: true }));
  if (host.strayContext.length > 0) {
    const w = `a context file above the run directory is also loaded by pi, so the reviewer's context is more than the stub: ${host.strayContext.join(", ")}`;
    runWarnings.push(w);
    warn(w);
  }
  // On a PR the bot already reviewed, what it posted counts as raised: read
  // through the resolved credential, skipped below. A failure only warns.
  const bot = prInfo
    ? await fetchBotFindings({
        repo: prInfo.repo,
        number: prInfo.number,
        token: prInfo.token,
        ...(gh?.fetchFn ? { fetchFn: gh.fetchFn } : {}),
        ...(gh?.apiBase ? { apiBase: gh.apiBase } : {}),
        ...(io.signal ? { signal: io.signal } : {}),
      })
    : { findings: [] as PostedFinding[] };
  if (bot.warning !== undefined) {
    runWarnings.push(bot.warning);
    warn(bot.warning);
  }
  // Memory seasons the prompt; it never fails or holds up the review.
  const seeded = opts.memory
    ? await opts.memory.seed({ title: roundTarget.title, files: t.files }, io.log)
    : MEMORY_NOT_SET_UP;
  if (seeded.notice !== null) progress(seeded.notice);
  const memoryReport = { used: seeded.used, notice: seeded.notice };
  if (io.signal?.aborted) return stopped();
  const sessionName = `review-${(kind === "diff" ? "diff" : kind === "uncommitted" ? "uncommitted" : t.branch).replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const roundNo = scope === "delta" && prev !== null ? lastRound(prev).round_no + 1 : 1;
  let shot: OneShotResult;
  let runTarget = roundTarget;
  try {
    if (kind === "diff") {
      // a plain directory: no git write, so a read-only checkout is enough
      const w = addDiffTree(repoDir, treeDir, t);
      if (w !== null) {
        runWarnings.push(w);
        warn(w);
      }
    } else if (kind === "uncommitted" || t.uncommitted !== undefined) {
      // the edits are committed in the review tree, so the advertised diff
      // names that snapshot rather than HEAD, which lacks them
      const snapshot = await addUncommittedTree(
        gitDir,
        treeDir,
        t,
        io.signal ? { signal: io.signal } : {},
      );
      runTarget = { ...roundTarget, headSha: snapshot };
    } else await addReviewTree(gitDir, treeDir, t.headSha, io.signal ? { signal: io.signal } : {});
    const round: RoundSpec = {
      root: opts.root,
      cwd: host.cwd,
      agentScope: "user",
      agentDir: host.agentDir,
      tree: treeDir,
      files: t.files,
      target: runTarget,
      outDir,
      cfg,
      ecosystem,
      timeoutMs: opts.limits.timeoutMs,
      // Rendered over the review tree, as production renders over its worktree.
      prompts: planRound(treeDir, seeded.memory, runTarget).prompts,
      ...(cap !== null ? { capUsd: cap } : {}),
      memory: seeded.memory,
      sessionName,
      // The round's LiveEvent log (src/live/): `qcr review status` and `qcr live`
      // read it from the run's own directory.
      live: { root: runDir, key: sessionName, round: roundNo },
      label: `${t.repo}@${kind === "diff" ? "diff" : kind === "uncommitted" ? "uncommitted" : t.branch}`,
      ...(io.log ? { log: io.log } : {}),
      ...(io.signal ? { signal: io.signal } : {}),
    };
    io.started?.({
      runDir,
      outDir,
      sessionName,
      lenses,
      estimateUsd: price,
      capUsd: cap,
    });
    if (runtime !== null) shot = await runOneShot({ ...round, runtime });
    // inside interactive pi: no live log and no cap, the person is watching
    else if (opts.debugRound !== undefined)
      shot = await opts.debugRound({ ...round, live: undefined });
    else throw new Error("the review has no runtime");
  } catch (err) {
    if (io.signal?.aborted) return stopped();
    return refuse(1, [`the review could not run: ${String(err).slice(0, 300)}`]);
  } finally {
    if (kind === "diff") rmSync(treeDir, { recursive: true, force: true });
    else removeReviewTree(gitDir, treeDir);
  }
  // A stopped round records nothing and posts nothing: what it wrote stays in
  // its out dir.
  if (io.signal?.aborted) return stopped();

  // pi stamps a cost of zero on a model it has no price for: what such a run
  // spent is not known, and a zero is never shown in its place.
  const spent = noDollarStop ? null : (shot.costUsd ?? shot.piRun.spentUsd ?? null);
  const spentWords = noDollarStop
    ? ` (spend unknown: pi has no price for ${named})`
    : spent === null
      ? ""
      : cap !== null
        ? ` (${usd(spent)} of ${usd(cap)})`
        : ` (${usd(spent)})`;
  const verdict = typeof shot.outcome?.["verdict"] === "string" ? shot.outcome["verdict"] : null;
  const started = startedLenses(outDir);
  const coverage = {
    planned: lenses,
    started,
    not_reached: lenses.filter((l) => !started.includes(l)),
  };
  // What a finished review adds to the target's state; an unfinished one
  // leaves the mark where it was. The findings the reader sees are this
  // round's own: a re-raised open finding is listed as still open, once.
  // A session that hit its deadline before writing its outcome never finished,
  // whatever findings it had written by then.
  const timedOutShort = shot.piRun.timedOut && shot.outcome === undefined;
  const finished =
    !shot.capped && shot.error === undefined && shot.findings !== undefined && !timedOutShort;
  const round: ReviewRound = {
    round_no: roundNo,
    head_sha: t.headSha,
    base_sha: t.baseSha,
    merge_base: t.mergeBase,
    reviewed_at: new Date().toISOString(),
    verdict,
    scope,
    cost_usd: spent,
  };
  const recorded = recordRound(scope === "delta" ? prev : null, targetKey, round, shot.findings);
  if (finished && keepsState) saveState(statePath, recorded.state);
  const open = finished ? stillOpen(recorded.state, round.round_no) : [];
  const skipped = skipPosted(recorded.fresh, bot.findings);
  const groups = groupFindings({ findings: finished ? skipped.fresh : [] });
  const unfinishedGroups = finished
    ? groups
    : groupFindings(rawWithout(shot.findings, bot.findings));
  const count = Object.values(unfinishedGroups).reduce((n, l) => n + l.length, 0);
  const data = {
    preview: previewData,
    findings: unfinishedGroups,
    still_open: open,
    repeats_suppressed: recorded.repeats.length,
    already_posted_skipped: skipped.skipped,
    verdict,
    cost_usd: spent,
    out_dir: outDir,
    warnings: [...runWarnings, ...shot.warnings],
    memory: memoryReport,
    customised: custom.customised,
    overrides: custom.overrides,
  };
  const customNotes = custom.customised ? [customisedNote(custom)] : [];
  const heading = scope === "delta" ? "New findings" : "Findings";
  const body = count > 0 ? ["", `${heading} (${count})`, ...renderGrouped(unfinishedGroups)] : [];
  if (shot.capped) {
    const human = [
      "",
      `Stopped at the cap shown (${usd(cap!)}; spent ${spent === null ? "unknown" : usd(spent)}).`,
      `Partial coverage: ${started.length} of ${lenses.length} planned lenses had started` +
        (coverage.not_reached.length ? `; not reached: ${coverage.not_reached.join(", ")}` : "") +
        ".",
      ...(count > 0 ? body : ["No findings were written before the stop."]),
      ...customNotes,
      `Files: ${outDir}`,
    ].join("\n");
    return finish(
      1,
      human,
      { ok: false, partial: true, coverage, ...data },
      renderMarkdown(
        {
          title: `Partial review of ${subject} (${t.repo})`,
          verdict,
          notes: [
            `Stopped at the cap shown (${usd(cap!)}): ${started.length} of ${lenses.length} planned lenses had started.`,
            ...customNotes,
          ],
        },
        unfinishedGroups,
      ),
    );
  }
  if (shot.error !== undefined || shot.findings === undefined || timedOutShort) {
    const why =
      shot.error ??
      (shot.findings === undefined
        ? "the review wrote no findings record"
        : "the review timed out before it finished");
    return finish(1, `\nThe review did not finish: ${why}\nFiles: ${outDir}`, {
      ok: false,
      partial: false,
      errors: [why],
      ...data,
    });
  }
  const mdMeta = {
    title: `Review of ${subject} (${t.repo})`,
    verdict,
    // the customised line closes the report: it is its footer
    notes: [...shot.warnings.slice(0, 5), ...customNotes],
  };
  const human = [
    "",
    `Review done${verdict ? `: ${verdict}` : ""}${spentWords}`,
    ...(count > 0 ? body.slice(1) : [scope === "delta" ? "No new findings." : "No findings."]),
    ...renderStillOpen(open),
    ...(recorded.repeats.length
      ? [
          `${recorded.repeats.length} re-raised finding${recorded.repeats.length === 1 ? "" : "s"} already open, not repeated.`,
        ]
      : []),
    ...(skipped.skipped
      ? [
          `${skipped.skipped} finding${skipped.skipped === 1 ? "" : "s"} the bot already posted on this PR, not repeated.`,
        ]
      : []),
    ...[...(bot.warning !== undefined ? [bot.warning] : []), ...shot.warnings]
      .slice(0, 5)
      .map((w) => `warning: ${w}`),
    ...customNotes,
    `Files: ${outDir}`,
  ].join("\n");
  // Posting to the PR: one comment-only review, marked, deduplicated. Sent
  // when the destinations say so, else when the person says yes to the offer.
  let posted: Record<string, unknown> | null = null;
  let postFailed = false;
  let postLine = "";
  let postReady: string | null = null;
  const markdown = renderMarkdown(mdMeta, groups);
  let post = sends("pr");
  if (!post && prInfo !== null && io.offerPost) {
    const offerPost = io.offerPost;
    const offer: PostOffer = {
      repo: prInfo.repo,
      pr: prInfo.number,
      markdown,
      findings: count,
      dryRun: opts.config.dry_run,
    };
    const yes = await unlessStopped(io.signal, (o) => offerPost(offer, o));
    post = yes === true && !io.signal?.aborted;
  }
  if (prInfo !== null) {
    // what the bot has not already posted, as the terminal shows it
    const toPost = assemblePostReview(rawWithout(shot.findings, bot.findings), {
      cfg,
      roundNo: round.round_no,
      customised: custom.customised,
      lenses,
      verdict,
      summary: typeof shot.outcome?.["summary"] === "string" ? shot.outcome["summary"] : null,
      // The fail-closed security lines, from the plan and the passes that
      // returned — the daemon's route reads its round progress instead.
      security: securityRowsNotReturned(shot.prompts.passPlan, shot.outcome),
    });
    const postAs = loadPostIdentity(repoDir);
    if (post) {
      const id = await resolvePostCredential(
        opts.config.github.secrets_dir,
        postAs,
        { source: prInfo.source, token: prToken },
        gh,
      );
      const out = await postAssembled({
        repo: t.repo,
        pr: prInfo.number,
        headSha: t.headSha,
        credential: id,
        review: toPost,
        skipped: skipped.skipped,
        dryRun: opts.config.dry_run,
        dryrunDir: opts.dryrunDir,
        ...(gh ? { github: gh } : {}),
        ...(io.log ? { log: io.log } : {}),
      });
      posted = out.post;
      postFailed = out.failed;
      postLine = out.line;
    } else {
      // Not posted: kept beside the run's files, so a host that asks the
      // person later posts exactly this (`postSavedReview`). No token is kept.
      const saved: SavedPost = {
        version: 1,
        repo: t.repo,
        pr: prInfo.number,
        head_sha: t.headSha,
        source: prInfo.source,
        post_as: postAs,
        skipped: skipped.skipped,
        review: toPost,
      };
      try {
        mkdirSync(outDir, { recursive: true });
        const file = join(outDir, SAVED_POST_FILE);
        writeFileSync(file, `${JSON.stringify(saved, null, 2)}\n`);
        postReady = file;
      } catch {
        // a review that cannot be kept for later is still the review
      }
    }
  }
  return finish(
    postFailed ? 1 : 0,
    postLine ? `${human}\n${postLine}` : human,
    {
      ok: !postFailed,
      partial: false,
      ...data,
      ...(posted ? { post: posted } : {}),
      ...(postReady !== null ? { post_ready: postReady } : {}),
    },
    markdown,
  );
}
