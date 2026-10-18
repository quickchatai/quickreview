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
// uncommitted tree), the sandbox (docker), the destination and posting and
// the detached run all hang off `runReviewCli`'s steps without changing its
// shape; a PR keys its state with its own target key.
//
// Exit codes follow `qcr scan`: 0 done; 1 refused, declined, failed or
// stopped short (partial); 2 usage.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
  fetchPrTarget,
  parsePrTarget,
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
  lastRound,
  loadState,
  openFindings,
  recordRound,
  saveState,
  statePathFor,
  type ReviewRound,
  type ReviewState,
} from "./reviewstate.js";

import type { ReviewRunner, ReviewSandboxChoice } from "./reviewbox.js";

export const REVIEW_USAGE =
  "usage: qcr review [branch | --uncommitted | <PR number|URL>] [--repo OWNER/NAME] [--base REF] [--preview] [--key K] [--limit USD] [--full] [--to DEST] [--out FILE] [--json] | --help";

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
    "  --to DEST         where the result goes, for this run: terminal, file, json (comma-separated)",
    "  --out FILE        write the markdown report to FILE (implies file)",
    "",
    "Destinations: with none given, the repo's saved default is used; with none saved, an",
    "interactive run asks and saves the answer for this repo (in its git dir), and a run",
    "with no terminal prints the terminal text plus JSON and never waits.",
    "",
    "A PR is read with the first GitHub credential found: the App if configured, then",
    "GITHUB_TOKEN/GH_TOKEN, then `gh auth token` (run `gh auth login` to set that up).",
    "",
    "With Docker the review runs in a throwaway container with the repo read-only and no",
    "GitHub token; without Docker it runs on the host and says so.",
    "",
    "A second run on an unchanged head spends nothing. After a push it reviews only",
    "the change since the last reviewed head and does not repeat findings that are",
    "still open; a history rewrite or a delta it cannot trust is reviewed in full.",
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
  /** Runs the review: the sandbox's container, or (absent) this process. */
  runner?: ReviewRunner;
  /** Said once, before a run starts, when it has no sandbox (src/reviewbox.ts). */
  sandboxWarning?: string;
  /** Where that warning is said (stderr). */
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
  const saved = explicit.length > 0 ? null : loadDefaultDestinations(deps.cwd);
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
  const label = prInfo
    ? `PR #${prInfo.number} against ${t.base}`
    : cmd.uncommitted
      ? `uncommitted changes on ${t.branch}`
      : `${t.branch} against ${t.base}`;
  const settings = loadReviewSettings(deps.cwd);
  const limit = cmd.limit ?? settings.auto_limit_usd;

  // What an earlier review of this target left (none with --full, or when it
  // cannot be trusted).
  const targetKey = branchTargetKey(t.repo, t.branch);
  const statePath = statePathFor(deps.cwd, targetKey);
  // only a branch keeps local state: a PR and the uncommitted tree always review in full
  const prev =
    cmd.full || prInfo !== null || cmd.uncommitted ? null : loadState(statePath, targetKey);
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
      const d = await computeDelta(deps.cwd, prev, t);
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
    // no PR behind this target: posting is never offered
    postable: false,
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

  // The first interactive run in a repo asks where results go and keeps the
  // answer for it; a run with no terminal and no default never waits.
  if (explicit.length === 0 && saved === null) {
    if (deps.choose) {
      const picked = await deps.choose(
        "Where should review results go?",
        destinationChoices({ pr: prInfo !== null }),
      );
      dests = [picked];
      saveDefaultDestinations(deps.cwd, dests);
    } else dests = FALLBACK_DESTINATIONS;
  }
  if (dests.includes("file"))
    reportPath = cmd.out !== undefined ? resolve(deps.cwd, cmd.out) : join(runDir, "report.md");

  mkdirSync(runDir, { recursive: true });
  // A host run is said once, so a laptop without Docker is never silently
  // unsandboxed. A preview runs nothing, so it says nothing.
  const sandboxWarnings = deps.sandboxWarning !== undefined ? [deps.sandboxWarning] : [];
  if (deps.sandboxWarning !== undefined)
    (deps.warn ?? ((l) => console.error(l)))(deps.sandboxWarning);
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
    sandboxWarnings.push(bot.warning);
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
    shot = await (deps.runner ?? runOneShot)({
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
  if (finished && prInfo === null && !cmd.uncommitted) saveState(statePath, recorded.state);
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
    warnings: [...sandboxWarnings, ...shot.warnings],
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
  deliver(human, { ok: true, partial: false, ...data }, renderMarkdown(mdMeta, groups));
  return 0;
}

/** Docker when present and usable, else the host (with its warning). Only
 * asked for a real run: a preview and help never reach docker. */
async function chooseSandbox(): Promise<ReviewSandboxChoice> {
  const [{ chooseReviewSandbox }, companion, { appStamp }, install, cfgMod] = await Promise.all([
    import("./reviewbox.js"),
    import("./tui/companion.js"),
    import("./appstamp.js"),
    import("./install.js"),
    import("./config.js"),
  ]);
  const env = process.env;
  let sandbox = {
    ...cfgMod.SCAN_SANDBOX_DEFAULTS,
    pihome_volume: cfgMod.COMPANION_DEFAULTS.pihome_volume,
    image: cfgMod.COMPANION_DEFAULTS.image,
  };
  try {
    sandbox = cfgMod.loadConfig().scan_sandbox;
  } catch {
    // No readable config: the defaults.
  }
  const appRoot = env["QCR_ROOT"]?.trim() || cfgMod.sandboxRoot();
  return chooseReviewSandbox({
    docker: companion.realDockerRunner,
    env,
    sandbox,
    appRoot,
    stamp: () => appStamp(appRoot),
    configSource: () => {
      const located = install.locateConfig({ env });
      return existsSync(located.path) ? located.path : undefined;
    },
  });
}

/** The terminal side: the real repo, root, login and a prompt on stdin. */
export async function cmdReview(rest: string[], json: boolean): Promise<number> {
  // The container's entry: `qcr review --run-spec <file>` (src/reviewbox.ts).
  if (rest[0] === "--run-spec") {
    const spec = rest[1];
    if (!spec) return 2;
    const { runReviewSpec } = await import("./reviewbox.js");
    const { contextFor } = await import("./bench/runner.js");
    return runReviewSpec(spec, {
      env: process.env,
      context: contextFor,
      log: (l) => console.error(l),
    });
  }
  const wantsRun = !rest.some((a) => a === "--preview" || a === "--help" || a === "-h");
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
  const choice = wantsRun ? await chooseSandbox() : {};
  return runReviewCli(rest, json, {
    ...(choice.runner ? { runner: choice.runner } : {}),
    ...(choice.warning !== undefined ? { sandboxWarning: choice.warning } : {}),
    cwd: process.cwd(),
    out: (l) => console.log(l),
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
    runsDir: join(stateHome(), "review", "runs"),
    memory: openReviewMemory(cfg0),
    timeoutMs: 60 * 60_000,
    log: (l) => console.error(l),
  });
}
