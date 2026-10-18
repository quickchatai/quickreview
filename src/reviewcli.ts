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
import { renderOneShotPrompts, runOneShot, type OneShotResult } from "./oneshot.js";
import type { ReviewRunner, ReviewSandboxChoice } from "./reviewbox.js";

export const REVIEW_USAGE =
  "usage: qcr review [branch] [--base REF] [--preview] [--key K] [--limit USD] [--json] | --help";

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
    "  --json            one JSON object instead of text",
    "",
    "With Docker the review runs in a throwaway container with the repo read-only and no",
    "GitHub token; without Docker it runs on the host and says so.",
    "",
    "The repo's limit and price rates live in `.git/qcr-review.json` (auto_limit_usd,",
    "usd_per_lens, usd_per_kline). Exit codes: 0 done; 1 refused, declined or stopped",
    "short (partial coverage); 2 usage.",
  ].join("\n");
}

export type ReviewCommand =
  { help: true } | { help: false; base?: string; preview: boolean; key?: string; limit?: number };

const usage = (why?: string): Error => new Error(why ? `${REVIEW_USAGE}\n(${why})` : REVIEW_USAGE);

/** `qcr review`'s arguments (`--json` taken off before). An unknown token is
 * refused, so a mistyped flag never runs something else. */
export function parseReviewArgs(rest: readonly string[]): ReviewCommand {
  let help = false;
  let preview = false;
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
  /** Runs the review: the sandbox's container, or (absent) this process. */
  runner?: ReviewRunner;
  /** Said once, before a run starts, when it has no sandbox (src/reviewbox.ts). */
  sandboxWarning?: string;
  /** Where that warning is said (stderr). */
  warn?: (line: string) => void;
}

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
  // The plan: the production round order's lens plan for this diff. Pure; the
  // checkout the person is standing in is only read.
  let lenses: string[];
  try {
    lenses = renderOneShotPrompts({
      root: deps.root,
      cfg: deps.cfg,
      ecosystem: deps.ecosystem,
      target,
      tree: deps.cwd,
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
  };
  const previewText = [
    `Review ${t.branch} against ${t.base} (${t.repo})`,
    `  ${t.files.length} file${t.files.length === 1 ? "" : "s"}, ${t.lines} changed line${t.lines === 1 ? "" : "s"}`,
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
  // A host run is said once, so a laptop without Docker is never silently
  // unsandboxed. A preview runs nothing, so it says nothing.
  const sandboxWarnings = deps.sandboxWarning !== undefined ? [deps.sandboxWarning] : [];
  if (deps.sandboxWarning !== undefined)
    (deps.warn ?? ((l) => console.error(l)))(deps.sandboxWarning);
  let shot: OneShotResult;
  try {
    addReviewTree(deps.cwd, treeDir, t.headSha);
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
    warnings: [...sandboxWarnings, ...shot.warnings],
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
    root,
    agentDir,
    cfg,
    ecosystem,
    runsDir: join(stateHome(), "review", "runs"),
    timeoutMs: 60 * 60_000,
    log: (l) => console.error(l),
  });
}
