// `qcr review` — a daemonless review from a terminal. This slice reviews the
// current branch against its base: it previews the price first, runs
// automatically under the repo's configured limit (otherwise asks), runs the
// shared one-shot core (src/oneshot.ts) on the host, stops hard at the price
// it showed, and prints the findings grouped by severity.
//
// The seams the sibling tickets plug into: `ReviewTargetSource` (a PR, the
// uncommitted tree), the sandbox (docker), the destination and posting, the
// detached run and the delta/skip state all hang off `runReviewCli`'s steps
// without changing its shape.
//
// Exit codes follow `qcr scan`: 0 done; 1 refused, declined, failed or
// stopped short (partial); 2 usage.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
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
  originRepo,
  resolveBranch,
  reviewKey,
  type BranchTarget,
} from "./localreview.js";
import type { CredentialSource } from "./ghcred.js";
import {
  fetchPrTarget,
  parsePrTarget,
  resolvePrCredential,
  type PrCredentialDeps,
  type PrFetchRequest,
} from "./prtarget.js";
import { renderOneShotPrompts, runOneShot, type OneShotResult } from "./oneshot.js";

export const REVIEW_USAGE =
  "usage: qcr review [branch|<PR number|URL>] [--repo OWNER/NAME] [--base REF] [--preview] [--key K] [--limit USD] [--json] | --help";

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
    "  --uncommitted     the uncommitted working tree — not available in this build yet",
    "",
    "Options",
    "  --repo OWNER/NAME the repository of a PR number (default: this directory's origin)",
    "  --base REF        the base to review against (default: origin's default branch, main, master)",
    "  --preview         show the plan, the price and the key; start nothing",
    "  --key K           start over the limit without asking, quoting the key a preview showed",
    "  --limit USD       the limit for this run, over the repo's own",
    "  --json            one JSON object instead of text",
    "",
    "A PR is read with the first GitHub credential found: the App if configured, then",
    "GITHUB_TOKEN/GH_TOKEN, then `gh auth token` (run `gh auth login` to set that up).",
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
      pr?: string;
      repo?: string;
      base?: string;
      preview: boolean;
      key?: string;
      limit?: number;
    };

const usage = (why?: string): Error => new Error(why ? `${REVIEW_USAGE}\n(${why})` : REVIEW_USAGE);

/** `qcr review`'s arguments (`--json` taken off before). An unknown token is
 * refused, so a mistyped flag never runs something else. */
export function parseReviewArgs(rest: readonly string[]): ReviewCommand {
  let help = false;
  let preview = false;
  let base: string | undefined;
  let pr: string | undefined;
  let repo: string | undefined;
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
    else if (a === "--base") base = value(i++, a);
    else if (a === "--repo") repo = value(i++, a);
    else if (a === "--key") key = value(i++, a);
    else if (a === "--limit") {
      const n = Number(value(i++, a));
      if (!Number.isFinite(n) || n <= 0)
        throw usage("--limit must be a positive number of dollars");
      limit = n;
    } else if (a === "branch") continue;
    else if (a === "--uncommitted")
      throw usage(`${a}: only a branch or a PR can be reviewed in this build`);
    else if (/^#?\d+$/.test(a) || /^https?:\/\//.test(a)) {
      if (pr !== undefined) throw usage("one PR at a time");
      pr = a;
    } else throw usage(`unknown argument ${a}`);
  }
  if (help) return { help: true };
  if (pr !== undefined && base !== undefined) throw usage("--base applies to a branch, not a PR");
  if (pr === undefined && repo !== undefined) throw usage("--repo goes with a PR number or URL");
  return {
    help: false,
    ...(pr !== undefined ? { pr } : {}),
    ...(repo !== undefined ? { repo } : {}),
    preview,
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
  /** Test seams for a PR target: the credential sources and where GitHub is. */
  pr?: PrCredentialDeps & Pick<PrFetchRequest, "fetchFn" | "gitBase" | "apiBase">;
}

const credentialLabel = (s: CredentialSource): string =>
  s === "app" ? "the GitHub App" : s === "gh" ? "gh auth login" : s.slice("env:".length);

const usd = (n: number): string => `$${n.toFixed(2)}`;

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
    };
  } else {
    const resolved = resolveBranch(deps.cwd, cmd.base);
    if (!resolved.ok) return refuse(1, [resolved.error]);
    t = resolved.target;
    runDir = join(deps.runsDir, `${stamp}-${t.headSha.slice(0, 7)}`);
  }
  const settings = loadReviewSettings(deps.cwd);
  const limit = cmd.limit ?? settings.auto_limit_usd;
  const outDir = join(runDir, "out");
  const treeDir = join(runDir, "tree");
  const target = {
    repo: t.repo,
    number: prInfo?.number ?? 0,
    title: prInfo?.title ?? `${t.branch} against ${t.base}`,
    body: prInfo?.body ?? null,
    headSha: t.headSha,
    baseRef: t.base,
    baseSha: t.baseSha,
    mergeBase: t.mergeBase,
  };
  // The plan: the production round order's lens plan for this diff. Pure; the
  // checkout the person is standing in is only read.
  let lenses: string[];
  try {
    lenses = renderOneShotPrompts({
      root: deps.root,
      cfg: deps.cfg,
      ecosystem: deps.ecosystem,
      target,
      tree: gitDir,
      caseDir: outDir,
      files: t.files,
      issuedAt: new Date().toISOString(),
    }).plannedLenses;
  } catch (err) {
    return refuse(1, [`the review plan could not be built: ${String(err).slice(0, 300)}`]);
  }
  const price = priceReview(lenses.length, t.lines, settings);
  const key = reviewKey({
    headSha: t.headSha,
    baseSha: t.baseSha,
    lenses,
    lines: t.lines,
    cap_usd: price,
  });
  const auto = price <= limit;
  const preview = {
    repo: t.repo,
    branch: t.branch,
    base: t.base,
    head_sha: t.headSha,
    files: t.files.length,
    lines: t.lines,
    lenses,
    estimate_usd: price,
    cap_usd: price,
    limit_usd: limit,
    auto,
    key,
    ...(prInfo ? { pr: prInfo.number, credential: prInfo.source } : {}),
  };
  const previewText = [
    `Review ${t.branch} against ${t.base} (${t.repo})`,
    `  ${t.files.length} file${t.files.length === 1 ? "" : "s"}, ${t.lines} changed line${t.lines === 1 ? "" : "s"}`,
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
  let shot: OneShotResult;
  try {
    addReviewTree(gitDir, treeDir, t.headSha);
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
      capUsd: price,
      sessionName: `review-${t.branch.replace(/[^A-Za-z0-9._-]/g, "-")}`,
      label: `${t.repo}@${t.branch}`,
      ...(deps.log ? { log: deps.log } : {}),
    });
  } catch (err) {
    return refuse(1, [`the review could not run: ${String(err).slice(0, 300)}`]);
  } finally {
    removeReviewTree(gitDir, treeDir);
  }

  const groups = groupFindings(shot.findings);
  const count = Object.values(groups).reduce((n, l) => n + l.length, 0);
  const spent = shot.costUsd ?? shot.piRun.spentUsd ?? null;
  const verdict = typeof shot.outcome?.["verdict"] === "string" ? shot.outcome["verdict"] : null;
  const started = startedLenses(outDir);
  const coverage = {
    planned: lenses,
    started,
    not_reached: lenses.filter((l) => !started.includes(l)),
  };
  const data = {
    preview,
    findings: groups,
    verdict,
    cost_usd: spent,
    out_dir: outDir,
    warnings: shot.warnings,
  };
  const body = count > 0 ? ["", `Findings (${count})`, ...renderGrouped(groups)] : [];
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
    ...(count > 0 ? body.slice(1) : ["No findings."]),
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
