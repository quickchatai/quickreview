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
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "./config.js";
import type { Ecosystem } from "./ecosystem.js";
import {
  addReviewTree,
  groupFindings,
  loadReviewSettings,
  priceReview,
  removeReviewTree,
  renderGrouped,
  resolveBranch,
  reviewKey,
  type BranchTarget,
} from "./localreview.js";
import {
  renderOneShotPrompts,
  runOneShot,
  type OneShotPrompts,
  type OneShotResult,
} from "./oneshot.js";
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

export const REVIEW_USAGE =
  "usage: qcr review [branch] [--base REF] [--preview] [--key K] [--limit USD] [--full] [--json] | --help";

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
    "  <PR number|URL>   a pull request — not available in this build yet",
    "  --uncommitted     the uncommitted working tree — not available in this build yet",
    "",
    "Options",
    "  --base REF        the base to review against (default: origin's default branch, main, master)",
    "  --preview         show the plan, the price and the key; start nothing",
    "  --key K           start over the limit without asking, quoting the key a preview showed",
    "  --limit USD       the limit for this run, over the repo's own",
    "  --full            review the whole branch again, ignoring what an earlier review left",
    "  --json            one JSON object instead of text",
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
  | { help: false; base?: string; preview: boolean; full: boolean; key?: string; limit?: number };

const usage = (why?: string): Error => new Error(why ? `${REVIEW_USAGE}\n(${why})` : REVIEW_USAGE);

/** `qcr review`'s arguments (`--json` taken off before). An unknown token is
 * refused, so a mistyped flag never runs something else. */
export function parseReviewArgs(rest: readonly string[]): ReviewCommand {
  let help = false;
  let preview = false;
  let full = false;
  let base: string | undefined;
  let key: string | undefined;
  let limit: number | undefined;
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
    else if (a === "--key") key = value(i++, a);
    else if (a === "--limit") {
      const n = Number(value(i++, a));
      if (!Number.isFinite(n) || n <= 0)
        throw usage("--limit must be a positive number of dollars");
      limit = n;
    } else if (a === "branch") continue;
    else if (a === "--uncommitted" || /^#?\d+$/.test(a) || /^https?:\/\//.test(a))
      throw usage(`${a}: only the current branch can be reviewed in this build`);
    else throw usage(`unknown argument ${a}`);
  }
  if (help) return { help: true };
  return {
    help: false,
    preview,
    full,
    ...(base !== undefined ? { base } : {}),
    ...(key !== undefined ? { key } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export interface ReviewCliDeps {
  /** The repository (or a directory in it) to review. */
  cwd: string;
  out: (line: string) => void;
  /** Ask a yes/no question of the person at the terminal. Null: nobody to ask. */
  confirm: ((question: string) => Promise<boolean>) | null;
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
  log?: (line: string) => void;
}

const usd = (n: number): string => `$${n.toFixed(2)}`;

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
  const say = (human: string, data: Record<string, unknown>): void =>
    deps.out(json ? JSON.stringify(data) : human);
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
  const resolved = resolveBranch(deps.cwd, cmd.base);
  if (!resolved.ok) return refuse(1, [resolved.error]);
  const t: BranchTarget = resolved.target;
  const settings = loadReviewSettings(deps.cwd);
  const limit = cmd.limit ?? settings.auto_limit_usd;

  // What an earlier review of this target left (none with --full, or when it
  // cannot be trusted).
  const targetKey = branchTargetKey(t.repo, t.branch);
  const statePath = statePathFor(deps.cwd, targetKey);
  const prev = cmd.full ? null : loadState(statePath, targetKey);
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

  const runId = `${new Date().toISOString().replace(/[^0-9]/g, "")}-${t.headSha.slice(0, 7)}`;
  const runDir = join(deps.runsDir, runId);
  const outDir = join(runDir, "out");
  const treeDir = join(runDir, "tree");
  const target = {
    repo: t.repo,
    number: 0,
    title: `${t.branch} against ${t.base}`,
    body: null,
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
    return { prompts: renderOneShotPrompts(common), scope: "full", fallback: why };
  };
  let planned: ReturnType<typeof planRound>;
  try {
    planned = planRound(deps.cwd);
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
    headSha: t.headSha,
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
  };
  const previewText = [
    `Review ${t.branch} against ${t.base} (${t.repo})`,
    scope === "delta"
      ? `  delta since ${short(since!)}: ${preview.files} file${preview.files === 1 ? "" : "s"}, ${priceLines} changed line${priceLines === 1 ? "" : "s"}; ${priorCount} earlier finding${priorCount === 1 ? "" : "s"} to verify`
      : `  ${t.files.length} file${t.files.length === 1 ? "" : "s"}, ${t.lines} changed line${t.lines === 1 ? "" : "s"}` +
        (fallback !== null ? ` — full review, not a delta: ${fallbackWords(fallback.reason)}` : ""),
    `  lenses: ${lenses.join(", ")}`,
    `  price: ${usd(price)} — the run stops hard there (limit without asking: ${usd(limit)})`,
    `  key: ${key}`,
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
  let shot: OneShotResult;
  try {
    addReviewTree(deps.cwd, treeDir, t.headSha);
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
      prompts: planRound(treeDir).prompts,
      capUsd: price,
      sessionName: `review-${t.branch.replace(/[^A-Za-z0-9._-]/g, "-")}`,
      label: `${t.repo}@${t.branch}`,
      ...(deps.log ? { log: deps.log } : {}),
    });
  } catch (err) {
    return refuse(1, [`the review could not run: ${String(err).slice(0, 300)}`]);
  } finally {
    removeReviewTree(deps.cwd, treeDir);
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
  if (finished) saveState(statePath, recorded.state);
  const open = finished ? stillOpen(recorded.state, round.round_no) : [];
  const groups = groupFindings({ findings: finished ? recorded.fresh : [] });
  const unfinishedGroups = finished ? groups : groupFindings(shot.findings);
  const count = Object.values(unfinishedGroups).reduce((n, l) => n + l.length, 0);
  const data = {
    preview,
    findings: unfinishedGroups,
    still_open: open,
    repeats_suppressed: recorded.repeats.length,
    verdict,
    cost_usd: spent,
    out_dir: outDir,
    warnings: shot.warnings,
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
    say(human, { ok: false, partial: true, coverage, ...data });
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
    ...shot.warnings.slice(0, 5).map((w) => `warning: ${w}`),
    `Files: ${outDir}`,
  ].join("\n");
  say(human, { ok: true, partial: false, ...data });
  return 0;
}

/** The terminal side: the real repo, root, login and a prompt on stdin. */
export async function cmdReview(rest: string[], json: boolean): Promise<number> {
  const { sandboxRoot, loadConfig } = await import("./config.js");
  const { stateHome } = await import("./install.js");
  const { contextFor } = await import("./bench/runner.js");
  const { createInterface } = await import("node:readline/promises");
  const { homedir } = await import("node:os");
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
    root,
    agentDir,
    cfg,
    ecosystem,
    runsDir: join(stateHome(), "review", "runs"),
    timeoutMs: 60 * 60_000,
    log: (l) => console.error(l),
  });
}
