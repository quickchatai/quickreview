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
// src/reviewdelta.ts), plan and price the round, ask above the limit, isolate
// the run (the host's `prepareHost`), run the one-shot round, skip what the
// bot already posted, record the round, render, and post through the one gate
// when asked.
//
// Nothing here reads the caller's cwd, home, environment or config file:
// every path, the config and the runtime are options, and every word for a
// person goes through the ports. A stop (`io.signal`) ends the run with a
// result, never the process.
//
// Exit codes follow `qcr scan`: 0 done; 1 refused, declined, failed or
// stopped short (partial); 2 usage.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { CoreConfig } from "./reviewconfig.js";
import type { Ecosystem } from "./ecosystem.js";
import {
  addDiffTree,
  addReviewTree,
  addUncommittedTree,
  groupFindings,
  loadReviewSettings,
  hardStopFor,
  priceReview,
  removeReviewTree,
  renderGrouped,
  originRepo,
  resolveBranch,
  resolveDiff,
  resolveUncommitted,
  reviewKey,
  type BranchTarget,
} from "./localreview.js";
import { MEMORY_NOT_SET_UP, type ReviewMemoryPort, type RoundMemory } from "./memoryport.js";
import type { ProfilePlace } from "./profilelookup.js";
import type { ProfileLookup } from "./profiles.js";
import {
  assemblePostReview,
  loadPostIdentity,
  localPostGate,
  postReviewToPr,
  type PostResult,
} from "./reviewpost.js";
import {
  fetchPrTarget,
  parsePrTarget,
  resolvePostCredential,
  resolvePrCredential,
  type CredentialSource,
  type PrCredentialDeps,
  type PrFetchRequest,
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
import { AuthExpiring } from "./engine/auth.js";
import type { Runtime } from "./engine/port.js";
import { fetchBotFindings, skipPosted, type PostedFinding } from "./reviewbotfindings.js";
import { computeDelta, deltaEnabled, renderDeltaRound, type DeltaFound } from "./reviewdelta.js";
import { REVIEW_SCHEMA_VERSION, withSchemaVersion } from "./contract.js";
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

/** What is reviewed. */
export type ReviewTarget =
  /** The repo dir's current branch against its base (`base`, else origin's
   * default branch, main, master). */
  | { kind: "branch"; base?: string }
  /** The uncommitted working tree (staged, unstaged and new files) against
   * HEAD. Never posted anywhere. */
  | { kind: "uncommitted" }
  /** A pull request: `12`, `#12` or a github.com pull URL. A PR on another
   * repo than the repo dir's needs `repo` (owner/name). */
  | { kind: "pr"; pr: string | number; repo?: string }
  /** A unified diff: its text, or a reader the run calls when it gets there
   * (a reader's Error message is the refusal, word for word). `name` says
   * where it came from: a file name, or "-" (or nothing) for a piped diff.
   * The repo dir is optional and only read; a diff is never posted. */
  | { kind: "diff"; diff: string | (() => Promise<string>); name?: string };

/** Who is asking. "laptop" previews the estimate, asks above the limit and
 * stops hard at twice the estimate. "action" never asks and has no cap of its
 * own: only a given limit stops the run. */
export type ReviewRoute = "laptop" | "action";

/** What the host's isolation of one run is given (the CLI's is
 * src/hostroute.ts `prepareHostRun`). */
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
   * with `AuthExpiring` (src/engine/auth.ts). */
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
  /** The limit for this run, over the repo's own (`auto_limit_usd`); on the
   * "action" route it is the hard stop. */
  limitUsd?: number;
  /** Start over the limit without asking, quoting the key a preview showed. */
  key?: string;
  /** The round's wall clock. */
  timeoutMs: number;
}

export interface ReviewOptions {
  /** The repository (or a directory in it) the review stands in. A diff
   * needs none there: it is then only read for context. */
  repoDir: string;
  /** The asset tree: prompts/, extensions/, agents/ (src/assetroot.ts). */
  root: string;
  /** The operator's pi agent dir (its login): only read. */
  agentDir: string;
  /** Where each run keeps its throwaway tree and its files. */
  runsDir: string;
  /** Where a dry-run install records the review it would have posted. */
  dryrunDir: string;
  /** The review home: each repo's delta history and saved destination
   * (src/reviewstore.ts). Null: nothing is remembered, so every run is a full
   * review and no destination is saved. */
  storeDir: string | null;
  config: CoreConfig;
  ecosystem: Ecosystem;
  /** Where profiles are looked up before the asset tree's examples. */
  profileHomes?: readonly ProfilePlace[];
  /** Hosts the review session. */
  runtime: Runtime;
  /** Isolates the run from the operator's pi home and every checkout. */
  prepareHost: (req: ReviewHostRequest) => ReviewHostRun;
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
  /** The GitHub credential sources and where GitHub is (a test seam). */
  github?: PrCredentialDeps & Pick<PrFetchRequest, "fetchFn" | "gitBase" | "apiBase">;
}

/** The ports: everything that reaches a person. */
export interface ReviewIo {
  /** Ask a yes/no question. Null or absent: nobody to ask. */
  confirm?: ((question: string) => Promise<boolean>) | null;
  /** Ask the person to pick one option. Absent: not interactive, so the
   * destination question is never asked. */
  choose?: (question: string, options: DestinationChoice[]) => Promise<Destination>;
  /** The run's own progress lines for a person (the preview before the run,
   * the memory notice). */
  progress?: (line: string) => void;
  /** A warning said before the run. */
  warn?: (line: string) => void;
  /** The round's diagnostics. */
  log?: (line: string) => void;
  /** Stops the review: it returns a stopped result and cleans up after itself. */
  signal?: AbortSignal;
}

/** The versioned JSON object (`qcr review --json`, schemas/review-result.v1.json). */
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

async function withCleanups(
  run: (cleanups: Array<() => void>) => Promise<ReviewResult>,
): Promise<ReviewResult> {
  const cleanups: Array<() => void> = [];
  try {
    return await run(cleanups);
  } finally {
    for (const c of cleanups) {
      try {
        c();
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
  cleanups: Array<() => void>,
): Promise<ReviewResult> {
  const isPreview = mode === "preview";
  const debug = opts.debugRound !== undefined && !isPreview;
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
    return {
      data: withSchemaVersion(REVIEW_SCHEMA_VERSION, data) as ReviewData,
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
    runDir = join(opts.runsDir, `${stamp}-pr${parsed.number}`);
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
    });
    if (!fetched.ok) return refuse(1, [fetched.error]);
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
          ? resolveUncommitted(repoDir)
          : resolveBranch(repoDir, target.base);
    if (!resolved.ok) return refuse(1, [resolved.error]);
    t = resolved.target;
    runDir = join(opts.runsDir, `${stamp}-${t.headSha.slice(0, 7)}`);
  }
  // The first interactive run in a repo asks where results go and keeps the
  // answer for it; a run with no terminal and no default never waits. The
  // answer comes before anything reads the destinations (posting to a PR
  // changes what is reviewed), and a preview, which starts nothing, never asks.
  if (explicit.length === 0 && saved === null && io.choose && !isPreview && !debug) {
    const picked = await io.choose(
      "Where should review results go?",
      destinationChoices({ pr: prInfo !== null }),
    );
    if (io.signal?.aborted) return stopped();
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
        : `${t.branch} against ${t.base}`;
  const kind: "pr" | "branch" | "uncommitted" | "diff" = target.kind;
  // what the markdown report is titled
  const subject = kind === "diff" ? label : `${t.branch} against ${t.base}`;
  const settings = loadReviewSettings(repoDir);
  const action = (opts.limits.route ?? "laptop") === "action";
  // The laptop's confirm threshold is the person's limit; the Action has none,
  // so only a limit given for this run applies, and it is the hard stop.
  const limit: number | null = action
    ? (opts.limits.limitUsd ?? null)
    : (opts.limits.limitUsd ?? settings.auto_limit_usd);

  // What an earlier review of this target left (none with `full`, or when it
  // cannot be trusted).
  // A branch and a PR each keep state under their own key (the PR's delta is
  // computed in its scratch repository); the uncommitted tree and a diff keep none.
  // A run that posts to a PR reviews in full: the findings already on the PR
  // (the posted-findings skip) are its repeat protection, and an
  // unchanged-head shortcut would also skip the post.
  const targetKey = prInfo
    ? prTargetKey(prInfo.repo, prInfo.number)
    : branchTargetKey(t.repo, t.branch);
  const keepsState = kind === "branch" || kind === "pr";
  const statePath =
    opts.storeDir === null
      ? null
      : (openReviewStoreIn(opts.storeDir, repoDir)?.statePath(targetKey) ?? null);
  const postsToPr = prInfo !== null && sends("pr");
  const prev = opts.full || !keepsState || postsToPr ? null : loadState(statePath, targetKey);
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
  // (src/profileoverrides.ts): the repo's `.qcr/` as the BASE commit has it,
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
  ): { prompts: OneShotPrompts; scope: "delta" | "full"; fallback: typeof fallback } => {
    const common = {
      root: opts.root,
      cfg,
      ecosystem,
      target: roundTarget,
      tree,
      caseDir: outDir,
      files: t.files,
      issuedAt: new Date().toISOString(),
      ...profileArgs,
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
      planTree = mkdtempSync(join(tmpdir(), "qcr-plan-"));
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
  const since = scope === "delta" && prev !== null ? lastRound(prev).head_sha : undefined;
  const priceLines = scope === "delta" && delta !== null ? delta.lines : t.lines;
  const price = priceReview(lenses.length, priceLines, settings);
  const cap: number | null = action ? limit : hardStopFor(price);
  const key = reviewKey({
    // an uncommitted review is keyed on the edits, so the key moves with them
    headSha: t.uncommitted?.treeSha ?? t.headSha,
    baseSha: t.baseSha,
    lenses,
    lines: priceLines,
    cap_usd: cap ?? 0,
    ...(since !== undefined ? { since } : {}),
  });
  const auto = action || price <= limit!;
  const priorCount = scope === "delta" ? openFindings(prev).findings.length : 0;
  const previewData = {
    repo: t.repo,
    target: { kind },
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
    estimate_usd: price,
    cap_usd: cap,
    limit_usd: limit,
    auto,
    key,
    ...(prInfo ? { pr: prInfo.number, credential: prInfo.source } : {}),
  };
  const previewText = [
    `Review ${label} (${t.repo})`,
    scope === "delta"
      ? `  delta since ${short(since!)}: ${previewData.files} file${previewData.files === 1 ? "" : "s"}, ${priceLines} changed line${priceLines === 1 ? "" : "s"}; ${priorCount} earlier finding${priorCount === 1 ? "" : "s"} to verify`
      : `  ${t.files.length} file${t.files.length === 1 ? "" : "s"}, ${t.lines} changed line${t.lines === 1 ? "" : "s"}` +
        (fallback !== null ? ` — full review, not a delta: ${fallbackWords(fallback.reason)}` : ""),
    `  lenses: ${lenses.join(", ")}`,
    action
      ? `  price: ${usd(price)} (estimate) — ${cap === null ? "no cap" : `the run stops hard at ${usd(cap)}`}`
      : `  price: ${usd(price)} (estimate) — the run stops hard at ${usd(cap!)} (limit without asking: ${usd(limit!)})`,
    `  key: ${key}`,
    ...(prInfo ? [`  GitHub credential: ${credentialLabel(prInfo.source)}`] : []),
    ...(custom.customised ? [`  ${customisedNote(custom)}`] : []),
  ];
  if (isPreview) return finish(0, previewText.join("\n"), { ok: true, preview: previewData });
  for (const l of previewText) progress(l);

  // Over the limit: the person's yes, or the key a preview showed.
  if (!auto) {
    const asked = opts.limits.key;
    if (asked !== undefined) {
      if (asked !== key)
        return refuse(1, [
          `--key ${asked} does not match this review (the branch, plan or price changed): preview again`,
        ]);
    } else if (!io.confirm) {
      return refuse(1, [
        `the price ${usd(price)} is over the limit ${usd(limit!)} and there is no terminal to ask: ` +
          `qcr review --key ${key}`,
      ]);
    } else if (!(await io.confirm(`Run for ${usd(price)}, over the ${usd(limit!)} limit?`))) {
      return refuse(1, [`declined: ${usd(price)} is over the ${usd(limit!)} limit`]);
    }
  }
  if (io.signal?.aborted) return stopped();

  mkdirSync(runDir, { recursive: true });
  const runWarnings: string[] = overrides.ignored.map((l) => `profile: ${l}`);
  // pi runs isolated from the operator's pi home, the asset tree and the
  // reviewed repo: a private agent dir and, as its cwd, the run's out dir
  // holding the reviewer stub (the host's `prepareHost`).
  let host: ReviewHostRun;
  try {
    host = opts.prepareHost({
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
  try {
    if (kind === "diff") {
      // a plain directory: no git write, so a read-only checkout is enough
      const w = addDiffTree(repoDir, treeDir, t);
      if (w !== null) {
        runWarnings.push(w);
        warn(w);
      }
    } else if (kind === "uncommitted") addUncommittedTree(gitDir, treeDir, t);
    else addReviewTree(gitDir, treeDir, t.headSha);
    const round: RoundSpec = {
      root: opts.root,
      cwd: host.cwd,
      agentScope: "user",
      agentDir: host.agentDir,
      tree: treeDir,
      files: t.files,
      target: roundTarget,
      outDir,
      cfg,
      ecosystem,
      timeoutMs: opts.limits.timeoutMs,
      // Rendered over the review tree, as production renders over its worktree.
      prompts: planRound(treeDir, seeded.memory).prompts,
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
    shot =
      debug && opts.debugRound !== undefined
        ? // inside interactive pi: no live log and no cap, the person is watching
          await opts.debugRound({ ...round, live: undefined })
        : await runOneShot({
            ...round,
            runtime: opts.runtime,
          });
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

  const spent = shot.costUsd ?? shot.piRun.spentUsd ?? null;
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
    `Review done${verdict ? `: ${verdict}` : ""}${spent === null ? "" : ` (${usd(spent)} of ${usd(price)})`}`,
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
  // Posting to the PR: one comment-only review, marked, deduplicated.
  let posted: Record<string, unknown> | null = null;
  let postFailed = false;
  let postLine = "";
  if (sends("pr") && prInfo !== null) {
    const id = await resolvePostCredential(
      opts.config.github.secrets_dir,
      loadPostIdentity(repoDir),
      { source: prInfo.source, token: prToken },
      gh,
    );
    // what the bot has not already posted, as the terminal shows it
    const toPost = assemblePostReview(rawWithout(shot.findings, bot.findings), {
      cfg,
      roundNo: round.round_no,
      customised: custom.customised,
      lenses,
      verdict,
      summary: typeof shot.outcome?.["summary"] === "string" ? shot.outcome["summary"] : null,
    });
    // Every finding was the bot's already (none left inline or in the body):
    // there is nothing to post, not even a review body to repeat.
    const res: PostResult = !id.ok
      ? id
      : skipped.skipped > 0 && toPost.comments.length === 0 && !toPost.bodyFindings
        ? { ok: true, posted: 0, skipped: skipped.skipped, url: null }
        : await postReviewToPr({
            repo: t.repo,
            number: prInfo.number,
            headSha: t.headSha,
            token: id.token,
            // The one gate, with the install's dry_run: a dry-run install records
            // the review under its dryrun dir and sends nothing (CLAUDE.md rule 1).
            gate: localPostGate({
              dryRun: opts.config.dry_run,
              dryrunDir: opts.dryrunDir,
              token: id.token,
              ...(gh?.fetchFn ? { fetchFn: gh.fetchFn } : {}),
              ...(gh?.apiBase ? { apiBase: gh.apiBase } : {}),
              ...(io.log ? { log: (msg: string) => io.log!(`[quickreviewd] ${msg}`) } : {}),
            }),
            review: toPost,
            ...(gh?.fetchFn ? { fetchFn: gh.fetchFn } : {}),
            ...(gh?.apiBase ? { apiBase: gh.apiBase } : {}),
          });
    if (res.ok && res.recorded !== undefined) {
      posted = {
        ok: true,
        posted: 0,
        skipped: res.skipped,
        url: null,
        dry_run: true,
        would_post: res.wouldPost,
        recorded: res.recorded,
      };
      postLine =
        `Dry run (dry_run = true in this install's config): the review of ${res.wouldPost} ` +
        `comment${res.wouldPost === 1 ? "" : "s"} on PR #${prInfo.number} was recorded, not posted: ${res.recorded}`;
    } else if (res.ok) {
      posted = { ok: true, posted: res.posted, skipped: res.skipped, url: res.url };
      postLine =
        res.posted === 0
          ? `Nothing posted: ${res.skipped} comment${res.skipped === 1 ? " is" : "s are"} already on the PR.`
          : `Posted ${res.posted} comment${res.posted === 1 ? "" : "s"} to PR #${prInfo.number} (comment-only review)` +
            `${res.skipped ? `, ${res.skipped} already there` : ""}${res.url ? `: ${res.url}` : ""}`;
    } else {
      postFailed = true;
      posted = { ok: false, error: res.error };
      postLine = `Review not posted: ${res.error}`;
    }
  }
  return finish(
    postFailed ? 1 : 0,
    postLine ? `${human}\n${postLine}` : human,
    { ok: !postFailed, partial: false, ...data, ...(posted ? { post: posted } : {}) },
    renderMarkdown(mdMeta, groups),
  );
}
