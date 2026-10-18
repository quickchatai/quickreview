// `qcr review` — a daemonless review from a terminal. This slice reviews the
// current branch against its base: it previews the price first, runs
// automatically under the repo's configured limit (otherwise asks), runs the
// shared one-shot core (src/oneshot.ts) on the host, stops hard at the price
// it showed, and prints the findings grouped by severity.
//
// Re-review: the state kept per target (src/reviewstate.ts) makes a second run
// on an unchanged head free, and a run after a push a delta review over the
// production follow-up plan (src/reviewdelta.ts) with the open findings handed
// over to verify and never repeated; a rewrite or a doubtful delta is a full
// review.
//
// The seams the sibling tickets plug into: `ReviewTargetSource` (a PR, the
// uncommitted tree), the destination and posting and the detached run all
// hang off `runReviewCli`'s steps without changing its shape; a PR keys its
// state with its own target key.
//
// Exit codes follow `qcr scan`: 0 done; 1 refused, declined, failed or
// stopped short (partial); 2 usage.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";
import type { Ecosystem } from "./ecosystem.js";
import {
  addReviewTree,
  addUncommittedTree,
  groupFindings,
  loadReviewSettings,
  priceReview,
  removeReviewTree,
  renderGrouped,
  originRepo,
  resolveBranch,
  resolveUncommitted,
  reviewKey,
  type BranchTarget,
} from "./localreview.js";
import type { RoundMemory } from "./memory/context.js";
import { seedReviewMemory, type ReviewMemorySource } from "./reviewmemory.js";
import type { CredentialSource } from "./ghcred.js";
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
  type PrCredentialDeps,
  type PrFetchRequest,
} from "./prtarget.js";
import {
  FALLBACK_DESTINATIONS,
  destinationChoices,
  loadDefaultDestinations,
  parseDestinations,
  renderMarkdown,
  saveDefaultDestinations,
  type Destination,
  type DestinationChoice,
} from "./reviewdest.js";
import {
  renderOneShotPrompts,
  runOneShot,
  type OneShotPrompts,
  type OneShotResult,
} from "./oneshot.js";
import { fetchBotFindings, skipPosted, type PostedFinding } from "./reviewbotfindings.js";
import { computeDelta, deltaEnabled, renderDeltaRound, type DeltaFound } from "./reviewdelta.js";
import {
  branchTargetKey,
  prTargetKey,
  lastRound,
  loadState,
  openFindings,
  recordRound,
  saveState,
  statePathFor,
  type ReviewRound,
  type ReviewState,
} from "./reviewstate.js";

export const REVIEW_USAGE =
  "usage: qcr review start|status|stop (detached runs, see `qcr review start --help`) | qcr review [branch | --uncommitted | <PR number|URL>] [--repo OWNER/NAME] [--base REF] [--preview] [--key K] [--limit USD] [--full] [--to DEST] [--out FILE] [--json] | --help";

export function reviewHelp(): string {
  return [
    REVIEW_USAGE,
    "",
    "Review code in the terminal, with no daemon. The price is previewed first;",
    "a review under the repo's limit starts at once, above it qcr asks, and the",
    "run stops hard at the price shown.",
    "",
    "Targets",
    "  (none), branch    the current branch against its base (default)",
    "  <PR number|URL>   a pull request, fetched into a scratch tree and reviewed read-only;",
    "                    a PR on another repo than this directory's needs --repo OWNER/NAME",
    "  --uncommitted     the uncommitted working tree (staged, unstaged and new files) against HEAD;\n                    never posted anywhere",
    "",
    "Options",
    "  --repo OWNER/NAME the repository of a PR number (default: this directory's origin)",
    "  --base REF        the base to review against (default: origin's default branch, main, master)",
    "  --preview         show the plan, the price and the key; start nothing",
    "  --key K           start over the limit without asking, quoting the key a preview showed",
    "  --limit USD       the limit for this run, over the repo's own",
    "  --full            review the whole branch again, ignoring what an earlier review left",
    "  --json            one JSON object instead of text (the agent destination)",
    "  --to DEST         where the result goes, for this run: terminal, file, json, pr (comma-separated;\n                    pr posts a comment-only review to the PR and needs a PR target)",
    "  --out FILE        write the markdown report to FILE (implies file)",
    "",
    "Destinations: with none given, the repo's saved default is used; with none saved, an",
    "interactive run asks and saves the answer for this repo (in its git dir), and a run",
    "with no terminal prints the terminal text plus JSON and never waits.",
    "",
    "Posting (--to pr, or saved as the default) sends one review whose event is always",
    "COMMENT, never an approval or a change request. Every comment says it came from qcr",
    "and carries the hidden finding markers, and findings already on the PR are skipped.",
    "It posts as the credential the PR was read with, or the source named by `post_as`",
    "(app, gh, env:GITHUB_TOKEN, env:GH_TOKEN) in `.git/qcr-review.json`. The post goes",
    "through the mutation gate: with `dry_run = true` in the install's config the review is",
    "recorded under state/dryrun/ and nothing is sent.",
    "",
    "A PR is read with the first GitHub credential found: the App if configured, then",
    "GITHUB_TOKEN/GH_TOKEN, then `gh auth token` (run `gh auth login` to set that up).",
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
    "usd_per_lens, usd_per_kline). Exit codes: 0 done; 1 refused, declined or stopped",
    "short (partial coverage); 2 usage.",
  ].join("\n");
}

export type ReviewCommand =
  | { help: true }
  | {
      help: false;
      uncommitted: boolean;
      pr?: string;
      repo?: string;
      base?: string;
      preview: boolean;
      key?: string;
      limit?: number;
      full: boolean;
      to?: Destination[];
      out?: string;
    };

const usage = (why?: string): Error => new Error(why ? `${REVIEW_USAGE}\n(${why})` : REVIEW_USAGE);

/** `qcr review`'s arguments (`--json` taken off before). An unknown token is
 * refused, so a mistyped flag never runs something else. */
export function parseReviewArgs(rest: readonly string[]): ReviewCommand {
  let help = false;
  let uncommitted = false;
  let preview = false;
  let full = false;
  let base: string | undefined;
  let pr: string | undefined;
  let repo: string | undefined;
  let key: string | undefined;
  let limit: number | undefined;
  let to: Destination[] | undefined;
  let out: string | undefined;
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
    else if (a === "--base") base = value(i++, a);
    else if (a === "--repo") repo = value(i++, a);
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
  if (pr !== undefined && base !== undefined) throw usage("--base applies to a branch, not a PR");
  if (pr === undefined && repo !== undefined) throw usage("--repo goes with a PR number or URL");
  return {
    help: false,
    uncommitted,
    ...(pr !== undefined ? { pr } : {}),
    ...(repo !== undefined ? { repo } : {}),
    preview,
    full,
    ...(base !== undefined ? { base } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(to !== undefined ? { to } : {}),
    ...(out !== undefined ? { out } : {}),
  };
}

export interface ReviewCliDeps {
  /** The repository (or a directory in it) to review. */
  cwd: string;
  out: (line: string) => void;
  /** Ask a yes/no question of the person at the terminal. Null: nobody to ask. */
  confirm: ((question: string) => Promise<boolean>) | null;
  /** Ask the person to pick one option. Absent: the session is not interactive,
   * so the destination question is never asked. */
  choose?: (question: string, options: DestinationChoice[]) => Promise<Destination>;
  /** The production tree (prompts/, extensions/, agents/). */
  root: string;
  /** pi's agent dir (its login). */
  agentDir: string;
  cfg: Config;
  ecosystem: Ecosystem;
  piBin?: string;
  /** Where each run keeps its throwaway tree and its files. */
  runsDir: string;
  timeoutMs: number;
  /** The install's OpenViking memory, when set up (src/reviewmemory.ts).
   * Absent or null: the review runs without memory and says so once. */
  memory?: ReviewMemorySource | null;
  log?: (line: string) => void;
  /** Test seams for a PR target: the credential sources and where GitHub is. */
  pr?: PrCredentialDeps & Pick<PrFetchRequest, "fetchFn" | "gitBase" | "apiBase">;
  /** Where a warning is said before the run (stderr). */
  warn?: (line: string) => void;
}

const credentialLabel = (s: CredentialSource): string =>
  s === "app" ? "the GitHub App" : s === "gh" ? "gh auth login" : s.slice("env:".length);

const usd = (n: number): string => `$${n.toFixed(2)}`;

/** An unfinished review's raw record, less the findings the bot already posted. */
function rawWithout(record: unknown, posted: readonly PostedFinding[]): unknown {
  const list = (record as { findings?: unknown } | null | undefined)?.findings;
  if (posted.length === 0 || !Array.isArray(list)) return record;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  const kept = skipPosted(
    list.map((e: Record<string, unknown>) => ({
      e,
      key: str(e["id"]) ?? str(e["key"]),
      path: str(e["path"]),
      title: str(e["title"]),
    })),
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

/** Run one `qcr review`; resolves its exit code. */
export async function runReviewCli(
  rest: readonly string[],
  json: boolean,
  deps: ReviewCliDeps,
): Promise<number> {
  const cleanups: Array<() => void> = [];
  try {
    return await runReview(rest, json, deps, cleanups);
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

async function runReview(
  rest: readonly string[],
  json: boolean,
  deps: ReviewCliDeps,
  cleanups: Array<() => void>,
): Promise<number> {
  // Where results go. Before the destination is settled, messages use what is
  // known: the flags, else the saved default, else the fallback.
  let dests: readonly Destination[] = json ? ["json"] : FALLBACK_DESTINATIONS;
  let reportPath: string | null = null;
  const deliver = (human: string, data: Record<string, unknown>, markdown?: string): void => {
    const to = new Set(dests);
    if (markdown !== undefined && to.has("file") && reportPath !== null) {
      try {
        mkdirSync(dirname(reportPath), { recursive: true });
        writeFileSync(reportPath, markdown);
        human += `\nReport: ${reportPath}`;
        data = { ...data, report: reportPath };
      } catch (err) {
        human += `\nThe report could not be written: ${String(err).slice(0, 200)}`;
      }
    }
    // A file-only destination still tells the terminal what happened.
    if (to.has("terminal") || !to.has("json")) deps.out(human);
    if (to.has("json")) deps.out(JSON.stringify(data));
  };
  const say = (human: string, data: Record<string, unknown>): void => deliver(human, data);
  const refuse = (code: number, errors: string[]): number => {
    say(errors.map((e) => `✗ ${e}`).join("\n"), { ok: false, errors });
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
  const explicit: Destination[] = [
    ...(json ? (["json"] as const) : []),
    ...(cmd.to ?? []),
    ...(cmd.out !== undefined ? (["file"] as const) : []),
  ].filter((d, i, a) => a.indexOf(d) === i);
  // Posting needs a PR: asked for on any other target, it is refused before
  // anything runs or is paid for.
  if (explicit.includes("pr") && cmd.pr === undefined)
    return refuse(2, [
      "--to pr posts to a pull request, and this target has no PR: pass a PR number or URL",
    ]);
  // A saved default that posts does not apply to a target with no PR.
  const savedAll = explicit.length > 0 ? null : loadDefaultDestinations(deps.cwd);
  const savedUse =
    savedAll === null || cmd.pr !== undefined ? savedAll : savedAll.filter((d) => d !== "pr");
  const saved = savedUse !== null && savedUse.length > 0 ? savedUse : null;
  if (explicit.length > 0) dests = explicit;
  else if (saved !== null) dests = saved;
  else if (deps.choose) dests = ["terminal"];
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "");
  // Where git commands run: the checkout the person stands in, or for a PR
  // the scratch repository its head and base were fetched into.
  let gitDir = deps.cwd;
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
  if (cmd.pr !== undefined) {
    const parsed = parsePrTarget(cmd.pr, {
      cwdRepo: originRepo(deps.cwd),
      ...(cmd.repo !== undefined ? { repo: cmd.repo } : {}),
    });
    if (!parsed.ok) return refuse(1, [parsed.error]);
    const cred = await resolvePrCredential(deps.cfg.github.secrets_dir, deps.pr);
    if (!cred.ok) return refuse(1, [cred.error]);
    runDir = join(deps.runsDir, `${stamp}-pr${parsed.number}`);
    const scratch = join(runDir, "repo");
    cleanups.push(() => rmSync(scratch, { recursive: true, force: true }));
    const fetched = await fetchPrTarget({
      repo: parsed.repo,
      number: parsed.number,
      scratchDir: scratch,
      token: cred.token,
      ...(deps.pr?.fetchFn ? { fetchFn: deps.pr.fetchFn } : {}),
      ...(deps.pr?.gitBase ? { gitBase: deps.pr.gitBase } : {}),
      ...(deps.pr?.apiBase ? { apiBase: deps.pr.apiBase } : {}),
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
    const resolved = cmd.uncommitted
      ? resolveUncommitted(deps.cwd)
      : resolveBranch(deps.cwd, cmd.base);
    if (!resolved.ok) return refuse(1, [resolved.error]);
    t = resolved.target;
    runDir = join(deps.runsDir, `${stamp}-${t.headSha.slice(0, 7)}`);
  }
  // The first interactive run in a repo asks where results go and keeps the
  // answer for it; a run with no terminal and no default never waits. The
  // answer comes before anything reads `dests` (posting to a PR changes what
  // is reviewed), and a preview, which starts nothing, never asks.
  if (explicit.length === 0 && saved === null && deps.choose && !cmd.preview) {
    const picked = await deps.choose(
      "Where should review results go?",
      destinationChoices({ pr: prInfo !== null }),
    );
    dests = [picked];
    saveDefaultDestinations(deps.cwd, dests);
  }
  if (dests.includes("file"))
    reportPath = cmd.out !== undefined ? resolve(deps.cwd, cmd.out) : join(runDir, "report.md");
  const label = prInfo
    ? `PR #${prInfo.number} against ${t.base}`
    : cmd.uncommitted
      ? `uncommitted changes on ${t.branch}`
      : `${t.branch} against ${t.base}`;
  const settings = loadReviewSettings(deps.cwd);
  const limit = cmd.limit ?? settings.auto_limit_usd;

  // What an earlier review of this target left (none with --full, or when it
  // cannot be trusted).
  // A branch and a PR each keep state under their own key (the PR's delta is
  // computed in its scratch repository); the uncommitted tree keeps none.
  // A run that posts to a PR reviews in full: the findings already on the PR
  // (the posted-findings skip) are its repeat protection, and an
  // unchanged-head shortcut would also skip the post.
  const targetKey = prInfo
    ? prTargetKey(prInfo.repo, prInfo.number)
    : branchTargetKey(t.repo, t.branch);
  const statePath = statePathFor(deps.cwd, targetKey);
  const postsToPr = prInfo !== null && dests.includes("pr");
  const prev = cmd.full || cmd.uncommitted || postsToPr ? null : loadState(statePath, targetKey);
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
      say(
        [
          `Nothing new: ${t.branch} is unchanged since the review at ${short(last.head_sha)} (${last.reviewed_at.slice(0, 10)}). Spent ${usd(0)}.`,
          ...renderStillOpen(open),
          "Pass --full to review the whole branch again.",
        ].join("\n"),
        {
          ok: true,
          unchanged: true,
          head_sha: t.headSha,
          reviewed_at: last.reviewed_at,
          cost_usd: 0,
          still_open: open,
        },
      );
      return 0;
    }
  }

  // The change since the last reviewed head, when it can be trusted.
  let delta: DeltaFound | null = null;
  let fallback: { reason: string; detail?: string } | null = null;
  if (prev !== null) {
    if (!deltaEnabled(deps.cfg)) fallback = { reason: "follow_up_full" };
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
    if (!cmd.preview) saveState(statePath, moved);
    const open = stillOpen(prev);
    say(
      [
        `Nothing new: ${t.branch} moved from ${short(last.head_sha)} to ${short(t.headSha)}, but none of its own changes did. Spent ${usd(0)}.`,
        ...renderStillOpen(open),
      ].join("\n"),
      { ok: true, unchanged: true, head_sha: t.headSha, cost_usd: 0, still_open: open },
    );
    return 0;
  }

  const outDir = join(runDir, "out");
  const treeDir = join(runDir, "tree");
  const target = {
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
      root: deps.root,
      cfg: deps.cfg,
      ecosystem: deps.ecosystem,
      target,
      tree,
      caseDir: outDir,
      files: t.files,
      issuedAt: new Date().toISOString(),
    };
    let why = fallback;
    if (prev !== null && delta !== null) {
      const fu = renderDeltaRound({ ...common, state: prev, delta });
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
    planned = planRound(gitDir);
  } catch (err) {
    return refuse(1, [`the review plan could not be built: ${String(err).slice(0, 300)}`]);
  }
  const lenses = planned.prompts.plannedLenses;
  const scope = planned.scope;
  fallback = planned.fallback;
  const since = scope === "delta" && prev !== null ? lastRound(prev).head_sha : undefined;
  const priceLines = scope === "delta" && delta !== null ? delta.lines : t.lines;
  const price = priceReview(lenses.length, priceLines, settings);
  const key = reviewKey({
    // an uncommitted review is keyed on the edits, so the key moves with them
    headSha: t.uncommitted?.treeSha ?? t.headSha,
    baseSha: t.baseSha,
    lenses,
    lines: priceLines,
    cap_usd: price,
    ...(since !== undefined ? { since } : {}),
  });
  const auto = price <= limit;
  const priorCount = scope === "delta" ? openFindings(prev).findings.length : 0;
  const preview = {
    repo: t.repo,
    target: cmd.uncommitted ? "uncommitted" : "branch",
    // posting is offered only when a PR is behind the target
    postable: prInfo !== null,
    branch: t.branch,
    base: t.base,
    head_sha: t.headSha,
    files: scope === "delta" && delta !== null ? delta.files.length : t.files.length,
    lines: priceLines,
    scope,
    ...(since !== undefined ? { since, prior_open: priorCount } : {}),
    ...(fallback !== null ? { fallback_reason: fallback.reason } : {}),
    lenses,
    estimate_usd: price,
    cap_usd: price,
    limit_usd: limit,
    auto,
    key,
    ...(prInfo ? { pr: prInfo.number, credential: prInfo.source } : {}),
  };
  const previewText = [
    `Review ${label} (${t.repo})`,
    scope === "delta"
      ? `  delta since ${short(since!)}: ${preview.files} file${preview.files === 1 ? "" : "s"}, ${priceLines} changed line${priceLines === 1 ? "" : "s"}; ${priorCount} earlier finding${priorCount === 1 ? "" : "s"} to verify`
      : `  ${t.files.length} file${t.files.length === 1 ? "" : "s"}, ${t.lines} changed line${t.lines === 1 ? "" : "s"}` +
        (fallback !== null ? ` — full review, not a delta: ${fallbackWords(fallback.reason)}` : ""),
    `  lenses: ${lenses.join(", ")}`,
    `  price: ${usd(price)} — the run stops hard there (limit without asking: ${usd(limit)})`,
    `  key: ${key}`,
    ...(prInfo ? [`  GitHub credential: ${credentialLabel(prInfo.source)}`] : []),
  ];
  if (cmd.preview) {
    say(previewText.join("\n"), { ok: true, preview });
    return 0;
  }
  if (!json) for (const l of previewText) deps.out(l);

  // Over the limit: the person's yes, or the key a preview showed.
  if (!auto) {
    if (cmd.key !== undefined) {
      if (cmd.key !== key)
        return refuse(1, [
          `--key ${cmd.key} does not match this review (the branch, plan or price changed): preview again`,
        ]);
    } else if (deps.confirm === null) {
      return refuse(1, [
        `the price ${usd(price)} is over the limit ${usd(limit)} and there is no terminal to ask: ` +
          `qcr review --key ${key}`,
      ]);
    } else if (!(await deps.confirm(`Run for ${usd(price)}, over the ${usd(limit)} limit?`))) {
      return refuse(1, [`declined: ${usd(price)} is over the ${usd(limit)} limit`]);
    }
  }

  mkdirSync(runDir, { recursive: true });
  const runWarnings: string[] = [];
  // On a PR the bot already reviewed, what it posted counts as raised: read
  // through the resolved credential, skipped below. A failure only warns.
  const bot = prInfo
    ? await fetchBotFindings({
        repo: prInfo.repo,
        number: prInfo.number,
        token: prInfo.token,
        ...(deps.pr?.fetchFn ? { fetchFn: deps.pr.fetchFn } : {}),
        ...(deps.pr?.apiBase ? { apiBase: deps.pr.apiBase } : {}),
      })
    : { findings: [] as PostedFinding[] };
  if (bot.warning !== undefined) {
    runWarnings.push(bot.warning);
    (deps.warn ?? ((l) => console.error(l)))(bot.warning);
  }
  // Memory seasons the prompt; it never fails or holds up the review.
  const seeded = await seedReviewMemory(
    deps.memory,
    { title: target.title, files: t.files },
    deps.log,
  );
  if (seeded.notice !== null && !json) deps.out(seeded.notice);
  const memoryReport = { used: seeded.used, notice: seeded.notice };
  let shot: OneShotResult;
  try {
    if (cmd.uncommitted) addUncommittedTree(gitDir, treeDir, t);
    else addReviewTree(gitDir, treeDir, t.headSha);
    shot = await runOneShot({
      root: deps.root,
      agentDir: deps.agentDir,
      tree: treeDir,
      files: t.files,
      target,
      outDir,
      cfg: deps.cfg,
      ecosystem: deps.ecosystem,
      timeoutMs: deps.timeoutMs,
      ...(deps.piBin !== undefined ? { piBin: deps.piBin } : {}),
      // Rendered over the review tree, as production renders over its worktree.
      prompts: planRound(treeDir, seeded.memory).prompts,
      capUsd: price,
      memory: seeded.memory,
      sessionName: `review-${(cmd.uncommitted ? "uncommitted" : t.branch).replace(/[^A-Za-z0-9._-]/g, "-")}`,
      label: `${t.repo}@${cmd.uncommitted ? "uncommitted" : t.branch}`,
      ...(deps.log ? { log: deps.log } : {}),
    });
  } catch (err) {
    return refuse(1, [`the review could not run: ${String(err).slice(0, 300)}`]);
  } finally {
    removeReviewTree(gitDir, treeDir);
  }

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
  const finished = !shot.capped && shot.error === undefined && shot.findings !== undefined;
  const round: ReviewRound = {
    round_no: scope === "delta" && prev !== null ? lastRound(prev).round_no + 1 : 1,
    head_sha: t.headSha,
    base_sha: t.baseSha,
    merge_base: t.mergeBase,
    reviewed_at: new Date().toISOString(),
    verdict,
    scope,
    cost_usd: spent,
  };
  const recorded = recordRound(scope === "delta" ? prev : null, targetKey, round, shot.findings);
  if (finished && !cmd.uncommitted) saveState(statePath, recorded.state);
  const open = finished ? stillOpen(recorded.state, round.round_no) : [];
  const skipped = skipPosted(recorded.fresh, bot.findings);
  const groups = groupFindings({ findings: finished ? skipped.fresh : [] });
  const unfinishedGroups = finished
    ? groups
    : groupFindings(rawWithout(shot.findings, bot.findings));
  const count = Object.values(unfinishedGroups).reduce((n, l) => n + l.length, 0);
  const data = {
    preview,
    findings: unfinishedGroups,
    still_open: open,
    repeats_suppressed: recorded.repeats.length,
    already_posted_skipped: skipped.skipped,
    verdict,
    cost_usd: spent,
    out_dir: outDir,
    warnings: [...runWarnings, ...shot.warnings],
    memory: memoryReport,
  };
  const heading = scope === "delta" ? "New findings" : "Findings";
  const body = count > 0 ? ["", `${heading} (${count})`, ...renderGrouped(unfinishedGroups)] : [];
  if (shot.capped) {
    const human = [
      "",
      `Stopped at the price shown (${usd(price)}; spent ${spent === null ? "unknown" : usd(spent)}).`,
      `Partial coverage: ${started.length} of ${lenses.length} planned lenses had started` +
        (coverage.not_reached.length ? `; not reached: ${coverage.not_reached.join(", ")}` : "") +
        ".",
      ...(count > 0 ? body : ["No findings were written before the stop."]),
      `Files: ${outDir}`,
    ].join("\n");
    deliver(
      human,
      { ok: false, partial: true, coverage, ...data },
      renderMarkdown(
        {
          title: `Partial review of ${t.branch} against ${t.base} (${t.repo})`,
          verdict,
          notes: [
            `Stopped at the price shown (${usd(price)}): ${started.length} of ${lenses.length} planned lenses had started.`,
          ],
        },
        groups,
      ),
    );
    return 1;
  }
  if (shot.error !== undefined || shot.findings === undefined) {
    const why = shot.error ?? "the review wrote no findings record";
    say(`\nThe review did not finish: ${why}\nFiles: ${outDir}`, {
      ok: false,
      partial: false,
      errors: [why],
      ...data,
    });
    return 1;
  }
  const mdMeta = {
    title: `Review of ${t.branch} against ${t.base} (${t.repo})`,
    verdict,
    notes: shot.warnings.slice(0, 5),
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
    `Files: ${outDir}`,
  ].join("\n");
  // Posting to the PR: one comment-only review, marked, deduplicated.
  let posted: Record<string, unknown> | null = null;
  let postFailed = false;
  let postLine = "";
  if (dests.includes("pr") && prInfo !== null) {
    const id = await resolvePostCredential(
      deps.cfg.github.secrets_dir,
      loadPostIdentity(deps.cwd),
      { source: prInfo.source, token: prToken },
      deps.pr,
    );
    // what the bot has not already posted, as the terminal shows it
    const review = assemblePostReview(rawWithout(shot.findings, bot.findings), {
      cfg: deps.cfg,
      roundNo: round.round_no,
      lenses,
      verdict,
      summary: typeof shot.outcome?.["summary"] === "string" ? shot.outcome["summary"] : null,
    });
    // Every finding was the bot's already: there is nothing to post, not even
    // a review body to repeat.
    const res: PostResult = !id.ok
      ? id
      : skipped.skipped > 0 && review.comments.length === 0
        ? { ok: true, posted: 0, skipped: skipped.skipped, url: null }
        : await postReviewToPr({
            repo: t.repo,
            number: prInfo.number,
            headSha: t.headSha,
            token: id.token,
            // The one gate, with the install's dry_run: a dry-run install records
            // the review under state/dryrun/ and sends nothing (CLAUDE.md rule 1).
            gate: localPostGate({
              dryRun: deps.cfg.dry_run,
              dryrunDir: join(deps.root, "state", "dryrun"),
              token: id.token,
              ...(deps.pr?.fetchFn ? { fetchFn: deps.pr.fetchFn } : {}),
              ...(deps.pr?.apiBase ? { apiBase: deps.pr.apiBase } : {}),
            }),
            review,
            ...(deps.pr?.fetchFn ? { fetchFn: deps.pr.fetchFn } : {}),
            ...(deps.pr?.apiBase ? { apiBase: deps.pr.apiBase } : {}),
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
  deliver(
    postLine ? `${human}\n${postLine}` : human,
    { ok: !postFailed, partial: false, ...data, ...(posted ? { post: posted } : {}) },
    renderMarkdown(mdMeta, groups),
  );
  return postFailed ? 1 : 0;
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

/** The terminal side: the real repo, root, login and a prompt on stdin. */
export async function cmdReview(
  rest: string[],
  json: boolean,
  io: { out?: (line: string) => void; runsDir?: string } = {},
): Promise<number> {
  // Detached runs for plugins (src/reviewdetach.ts): `start | status | stop`,
  // and the child `start` launches.
  if (rest[0] === "start" || rest[0] === "status" || rest[0] === "stop") {
    const verb = rest[0];
    const { randomBytes } = await import("node:crypto");
    const det = await import("./reviewdetach.js");
    const { stateHome } = await import("./install.js");
    return det.runDetachedVerb(verb, rest.slice(1), json, {
      home: join(stateHome(), "review", "detached"),
      out: (l) => console.log(l),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () =>
        `${new Date()
          .toISOString()
          .replace(/[^0-9]/g, "")
          .slice(0, 14)}-${randomBytes(3).toString("hex")}`,
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
        det.launchDetached({
          ...detachedCommand(l),
          dir: l.dir,
          env: process.env,
        }),
    });
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
        code = await cmdReview(rest.slice(3), true, { out, runsDir: join(dir, "work") });
        return code;
      },
    });
    return code;
  }
  const { sandboxRoot, loadConfig } = await import("./config.js");
  const { stateHome } = await import("./install.js");
  const { contextFor } = await import("./bench/runner.js");
  const { createInterface } = await import("node:readline/promises");
  const { homedir } = await import("node:os");
  const { openReviewMemory } = await import("./reviewmemory.js");
  const root = sandboxRoot();
  const cfg0 = loadConfig();
  const { cfg, ecosystem } = contextFor(root, cfg0.review.profile);
  const interactive = Boolean(process.stdin.isTTY && process.stderr.isTTY);
  const agentDir =
    process.env["PI_CODING_AGENT_DIR"]?.trim() ||
    join(process.env["HOME"] || homedir(), ".pi", "agent");
  if (!existsSync(join(agentDir, "auth.json")) && !json)
    console.error(
      `note: no pi login at ${agentDir} — run \`qcr scan login\` first if the review fails`,
    );
  return runReviewCli(rest, json, {
    cwd: process.cwd(),
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
    agentDir,
    cfg,
    ecosystem,
    runsDir: io.runsDir ?? join(stateHome(), "review", "runs"),
    memory: openReviewMemory(cfg0),
    timeoutMs: 60 * 60_000,
    log: (l) => console.error(l),
  });
}
