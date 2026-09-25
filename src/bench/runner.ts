// AACR-Bench review runner — one production review round per case, offline,
// inside the `qcr-bench` sandbox (bench/aacr/Dockerfile).
//
// What is PRODUCTION here, byte for byte: the persona
// (prompts/conversation-system.md), the round order (prompts/round-first.md
// through the production renderer), the pass plan (buildRoundOrder →
// buildPassPlan), the built lens + validator agents (buildAgents with
// PASS_ADDENDA and, if chosen, a profile's addenda), the models and tiers
// (config.toml [models]) and the pi extensions a PR session loads for its
// review work (subagents glue + ledger-pin; bash-guard globally, as the VM
// registers it).
//
// What is NOT, and why:
//   - memory: off. A benchmark of a foreign repo must not read quickchat
//     memory, and a PR session's memory extension would also WRITE its turns
//     into reviewer memory (vendor/openviking-pi syncTurns).
//   - inject-bridge / tmux: a benchmark round is one `pi -p` process that
//     exits when the agent settles; there is no daemon to deliver wakes.
//   - GitHub/CI/posting: replaced by `benchAppendix` (see aacr.ts header).
//   - profile: generic ("") by default — the quickchat profile's Django house
//     rules would be noise on a Rust PR. `--profile quickchat` measures
//     production as deployed.

import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { loadConfig, type Config } from "../config.js";
import { buildRoundOrder } from "../dispatch.js";
import { ecosystemFor, type Ecosystem } from "../ecosystem.js";
import type { PrFileEntry } from "../github.js";
import { buildAgents, identityVars, PASS_ADDENDA } from "../include.js";
import { MEMORY_LESS } from "../memory/context.js";
import { loadProfileAddenda, loadProfileEcosystem, loadProfileHeuristics } from "../profiles.js";
import { directiveVocabulary, isFirstPartyDirectivePath } from "../severity.js";
import type { PrStateRow } from "../state.js";
import {
  renderConversationSystemPrompt,
  renderRoundPrompt,
  roundTemplateFile,
} from "../templates.js";
import {
  benchAppendix,
  CASE_FILES,
  filesFromGitDiff,
  parseSessionComments,
  patchFromGitDiff,
  safeId,
  toOcrResult,
  usageFromEvents,
  VARIANTS,
  type BenchCase,
  type BenchComment,
  type PrefetchMeta,
  type Variant,
} from "./aacr.js";
import { must, run } from "./exec.js";

export interface RunnerOptions {
  /** The production tree inside the image (`/opt/quickreview/sandbox`) — the
   * session's cwd, exactly as on the VM. */
  root: string;
  /** Prefetched per-instance object stores (read-only mount). */
  store: string;
  /** This run's output dir (the one host bind mount that is written). */
  outDir: string;
  /** pi's agent dir: the SHARED login (auth.json + its lock) with the bench's
   * own settings.json/trust.json shadowed over it. */
  agentDir: string;
  profile: string;
  timeoutMs: number;
  piBin?: string;
  keepTree?: boolean;
  log?: (line: string) => void;
}

export interface CaseSummary {
  instance_id: string;
  status: "ok" | "no-output" | "timeout" | "failed";
  error?: string;
  verdict: string | null;
  duration_seconds: number;
  usage: { input: number; output: number; cacheRead: number; children: number };
  planned_lenses: string[];
  executed_passes: string[];
  comments: {
    total: number;
    by_tag: Record<string, number>;
    left_side: number;
    unparseable: number;
  };
  pr_meta: { title: boolean; body: boolean; base_ref_source: string };
  diff: { files: number; additions: number; deletions: number };
  continued: boolean;
  /** pi's stderr warnings/errors, deduplicated — a degraded run (settings
   * ignored, an extension that failed to load) must be visible in the report,
   * not only in a log nobody opens. */
  warnings: string[];
}

const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
};

async function git(tree: string, args: string[]): Promise<string> {
  return must("git", ["-C", tree, ...args], { env: GIT_ENV, timeoutMs: 10 * 60_000 });
}

/** The bench config: production config.toml with only the profile swapped.
 * Escalation stays whatever it ships as (off), so no escalation note renders. */
export function benchConfig(root: string, profile: string): Config {
  const cfg = structuredClone(loadConfig(join(root, "config.toml")));
  cfg.review.profile = profile;
  return cfg;
}

/** Build the lens + validator agents into `<root>/.pi/agents` — the PROJECT
 * scope the subagents glue reads when QCR_SUBAGENT_SCOPE=project. The VM uses
 * the user scope (a symlink in its own pihome); here the user scope is the
 * companion's shared agent dir, whose `agents` belongs to the companion. */
export function buildBenchAgents(root: string, cfg: Config): number {
  const out = join(root, ".pi", "agents");
  // Empty it rather than remove it: in the sandbox it is a tmpfs MOUNTPOINT
  // (the root filesystem is read-only), and a mountpoint cannot be rmdir'd.
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(out)) rmSync(join(out, f), { recursive: true, force: true });
  const built = buildAgents(join(root, "agents"), out, {
    root,
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    validateTier: cfg.models.validate_tier,
    vars: identityVars(cfg),
    addenda: [...PASS_ADDENDA, ...loadProfileAddenda(root, cfg.review.profile)],
  });
  return built.length;
}

/**
 * Materialise the reviewed head as a fresh repo whose objects come from the
 * prefetched store through `alternates` (the store is mounted read-only, so
 * nothing can be written back into it) and whose only refs are the detached
 * head and `origin/<base_ref>` at the PR's base — the exact vocabulary the
 * round template uses. No other ref, so no later commit, is reachable.
 */
async function prepareTree(store: string, tree: string, meta: PrefetchMeta): Promise<void> {
  rmSync(tree, { recursive: true, force: true });
  mkdirSync(tree, { recursive: true });
  await git(tree, ["init", "--quiet"]);
  writeFileSync(join(tree, ".git", "objects", "info", "alternates"), `${join(store, "objects")}\n`);
  const shallow = join(store, "shallow");
  if (existsSync(shallow)) writeFileSync(join(tree, ".git", "shallow"), readFileSync(shallow));
  await git(tree, ["update-ref", `refs/remotes/origin/${meta.base_ref}`, meta.base_commit]);
  await git(tree, [
    "-c",
    "advice.detachedHead=false",
    "checkout",
    "--quiet",
    "--detach",
    meta.head_commit,
  ]);
}

async function changedFiles(tree: string, meta: PrefetchMeta): Promise<PrFileEntry[]> {
  const range = [meta.merge_base, meta.head_commit];
  const nameStatus = await git(tree, ["diff", "-z", "--name-status", "-M", ...range]);
  const numstat = await git(tree, ["diff", "-z", "--numstat", "-M", ...range]);
  const patches = new Map<string, string>();
  const first = filesFromGitDiff(nameStatus, numstat);
  // Per-file hunks for the lens probes, bounded: past 300 files a PR's patch
  // content stops changing which lenses fire.
  for (const f of first.slice(0, 300)) {
    const d = await run("git", ["-C", tree, "diff", ...range, "--", f.filename], {
      env: GIT_ENV,
      maxBytes: 400_000,
    });
    const p = d.code === 0 ? patchFromGitDiff(d.stdout) : undefined;
    if (p !== undefined) patches.set(f.filename, p);
  }
  return filesFromGitDiff(nameStatus, numstat, patches);
}

/** The round order + system prompt this case runs — production renderers. */
export function renderCasePrompts(args: {
  root: string;
  cfg: Config;
  ecosystem: Ecosystem;
  c: BenchCase;
  meta: PrefetchMeta;
  tree: string;
  caseDir: string;
  files: PrFileEntry[];
  issuedAt: string;
}): { system: string; order: string; plannedLenses: string[] } {
  const { root, cfg, c, meta, tree } = args;
  const identity = { ...identityVars(cfg), repo: c.repo };
  const title = meta.title ?? `AACR-Bench ${c.repo}#${c.pr}`;
  const vocab = directiveVocabulary(cfg.review.directives);
  const directiveFiles = args.files
    .filter((f) => isFirstPartyDirectivePath(f.filename, vocab))
    .map((f) => f.filename);
  const row = {
    number: c.pr,
    state: "reviewing",
    head_sha: c.head_commit,
    title,
    author: "",
  } as unknown as PrStateRow;
  const order = buildRoundOrder({
    cfg,
    row,
    files: args.files,
    roundId: 1,
    roundNo: 1,
    reviewNo: 1,
    roundType: "first",
    worktree: tree,
    settledDigest: "",
    issuedAt: args.issuedAt,
    tree: {
      head_sha: c.head_commit,
      base_ref: meta.base_ref,
      base_sha: meta.base_commit,
      merge_base: meta.merge_base,
    },
    ...(meta.body !== null ? { prBody: meta.body } : {}),
    ...(directiveFiles.length
      ? { firstPartyDirectives: { files: directiveFiles, mention: "maintainer" } }
      : {}),
    ecosystem: args.ecosystem,
    heuristics: loadProfileHeuristics(root, cfg.review.profile),
  });
  const template = readFileSync(join(root, "prompts", roundTemplateFile("first")), "utf8");
  const rendered = renderRoundPrompt(
    template,
    order,
    MEMORY_LESS,
    cfg.owner.name,
    args.ecosystem,
    identity,
  );
  // An argv string caps at 128 KiB (MAX_ARG_STRLEN); a PR description is the
  // one unbounded input, so it is the one that gets cut.
  const body =
    meta.body !== null && meta.body.length > 20_000
      ? `${meta.body.slice(0, 20_000)}\n…(truncated)`
      : meta.body;
  const orderText =
    rendered +
    "\n\n" +
    benchAppendix({
      repo: c.repo,
      pr: c.pr,
      headSha: c.head_commit,
      mergeBase: meta.merge_base,
      caseDir: args.caseDir,
      title: meta.title,
      body,
    });
  const system = renderConversationSystemPrompt(
    readFileSync(join(root, "prompts", "conversation-system.md"), "utf8"),
    { pr: c.pr, title, worktree: tree },
    identity,
  );
  return { system, order: orderText, plannedLenses: order.pass_plan.map((p) => p.agent) };
}

interface PiRun {
  code: number | null;
  timedOut: boolean;
}

function runPi(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  eventsPath: string,
  stderrPath: string,
  timeoutMs: number,
  piBin: string,
): Promise<PiRun> {
  return new Promise((resolve) => {
    const events = createWriteStream(eventsPath, { flags: "a" });
    const errs = createWriteStream(stderrPath, { flags: "a" });
    // detached: its own process group, so a timeout kills the lens children
    // with it rather than orphaning six pi processes on the model API.
    const child = spawn(piBin, argv, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    child.stdout.pipe(events);
    child.stderr.pipe(errs);
    let timedOut = false;
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 15_000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      errs.write(`spawn error: ${String(e)}\n`);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      events.end();
      errs.end();
      resolve({ code, timedOut });
    });
  });
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/** Review one case end to end and write its scored result files. Never throws
 * for a case that fails — a failure is a recorded outcome. */
export async function reviewCase(
  c: BenchCase,
  meta: PrefetchMeta,
  o: RunnerOptions,
  ctx: { cfg: Config; ecosystem: Ecosystem },
): Promise<CaseSummary> {
  const log = o.log ?? (() => {});
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  mkdirSync(caseDir, { recursive: true });
  for (const f of Object.values(CASE_FILES)) rmSync(join(caseDir, f), { force: true });
  const started = Date.now();
  const summary: CaseSummary = {
    instance_id: c.instance_id,
    status: "failed",
    verdict: null,
    duration_seconds: 0,
    usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
    planned_lenses: [],
    executed_passes: [],
    comments: { total: 0, by_tag: {}, left_side: 0, unparseable: 0 },
    pr_meta: {
      title: meta.title !== null,
      body: meta.body !== null,
      base_ref_source: meta.base_ref_source,
    },
    diff: meta.diff,
    continued: false,
    warnings: [],
  };
  let comments: BenchComment[] = [];
  try {
    await prepareTree(join(o.store, safe), tree, meta);
    const files = await changedFiles(tree, meta);
    const prompts = renderCasePrompts({
      root: o.root,
      cfg: ctx.cfg,
      ecosystem: ctx.ecosystem,
      c,
      meta,
      tree,
      caseDir,
      files,
      issuedAt: new Date().toISOString(),
    });
    summary.planned_lenses = prompts.plannedLenses;
    const sysPath = join(caseDir, "system-prompt.md");
    writeFileSync(sysPath, prompts.system);
    writeFileSync(join(caseDir, "round-order.md"), prompts.order);
    writeFileSync(
      join(caseDir, "files.json"),
      JSON.stringify(
        files.map(({ patch: _p, ...f }) => f),
        null,
        2,
      ),
    );

    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: o.agentDir,
      QCR_SUBAGENT_SCOPE: "project",
      QCR_SUBAGENT_MAX_CONCURRENCY: String(ctx.cfg.pi.subagent_max_concurrency),
      QCR_SANDBOX_ROOT: o.root,
      QCR_SESSION_NAME: `bench-${safe}`,
      QCR_PR: String(c.pr),
      QCR_PR_META: `PR #${c.pr} — ${meta.title ?? c.repo} (worktree ${tree})`,
      QCR_WORKTREE: tree,
      QCR_LEDGER_FILE: join(caseDir, "ledger.md"),
      QCR_PI_VERSION: ctx.cfg.pi.version,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    };
    const sessionDir = join(caseDir, "session");
    const base = [
      "--approve",
      "--model",
      ctx.cfg.models.conversation,
      "--session-dir",
      sessionDir,
      "--system-prompt",
      sysPath,
      "--extension",
      join(o.root, "extensions", "ledger-pin.ts"),
      "--extension",
      join(o.root, "extensions", "subagents.ts"),
      "--name",
      `bench-${safe}`,
      "--mode",
      "json",
    ];
    const piBin = o.piBin ?? "pi";
    const events = join(caseDir, "pi-events.jsonl");
    const stderr = join(caseDir, "pi-stderr.log");
    rmSync(events, { force: true });
    rmSync(stderr, { force: true });
    log(
      `review: ${c.instance_id} — ${files.length} files, lenses ${prompts.plannedLenses.join(" ")}`,
    );
    let r = await runPi(
      [...base, "-p", prompts.order],
      env,
      o.root,
      events,
      stderr,
      o.timeoutMs,
      piBin,
    );
    const outcomePath = join(caseDir, CASE_FILES.outcome);
    // One continuation, never more: the live system's answer to a round that
    // stopped short is redelivery, not a fresh review (#5362). Same session.
    if (!r.timedOut && !existsSync(outcomePath)) {
      const left = o.timeoutMs - (Date.now() - started);
      if (left > 120_000) {
        summary.continued = true;
        log(`review: ${c.instance_id} — no outcome.json yet, one continuation`);
        r = await runPi(
          [
            ...base,
            "--continue",
            "-p",
            `You stopped before the BENCHMARK MODE files were complete. Finish the round now and write ${CASE_FILES.comments}, ${CASE_FILES.review}, ${CASE_FILES.findings} and, last, ${CASE_FILES.outcome} in ${caseDir}.`,
          ],
          env,
          o.root,
          events,
          stderr,
          left,
          piBin,
        );
      }
    }
    summary.warnings = [
      ...new Set(
        readFileSync(stderr, "utf8")
          .split("\n")
          .filter((l) => /warn|error|fatal|failed/i.test(l))
          .map((l) => l.trim().slice(0, 300)),
      ),
    ].slice(0, 20);
    const lines = readFileSync(events, "utf8").split("\n");
    summary.usage = usageFromEvents(lines);
    const outcome = readJson(outcomePath) as Record<string, unknown> | undefined;
    const rawComments = readJson(join(caseDir, CASE_FILES.comments));
    const parsed = parseSessionComments(rawComments);
    comments = parsed.comments;
    summary.comments.unparseable = parsed.dropped;
    summary.verdict = typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null;
    summary.executed_passes = Array.isArray(outcome?.["passes"])
      ? (outcome["passes"] as Array<Record<string, unknown>>).map(
          (p) => `${String(p["name"])}--${String(p["tier"])}`,
        )
      : [];
    summary.status = r.timedOut
      ? "timeout"
      : outcome !== undefined && rawComments !== undefined
        ? "ok"
        : "no-output";
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`review: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  summary.comments.total = comments.length;
  summary.comments.left_side = comments.filter((x) => x.side === "LEFT").length;
  for (const x of comments)
    summary.comments.by_tag[x.tag] = (summary.comments.by_tag[x.tag] ?? 0) + 1;
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeResults(o.outDir, c, comments, summary);
  log(
    `review: ${c.instance_id} ${summary.status} — verdict ${summary.verdict ?? "none"}, ${comments.length} comment(s), ${summary.duration_seconds}s`,
  );
  return summary;
}

/** Write the scorer's input for every variant. */
export function writeResults(
  outDir: string,
  c: BenchCase,
  comments: readonly BenchComment[],
  summary: CaseSummary,
): void {
  for (const variant of Object.keys(VARIANTS) as Variant[]) {
    const dir = join(outDir, "results", variant);
    mkdirSync(dir, { recursive: true });
    const result = toOcrResult(comments, {
      instance_id: c.instance_id,
      status: summary.status,
      variant,
      duration_seconds: summary.duration_seconds,
      usage: {
        input: summary.usage.input,
        output: summary.usage.output,
        cacheRead: summary.usage.cacheRead,
      },
      verdict: summary.verdict,
      unparseable: summary.comments.unparseable,
    });
    writeFileSync(
      join(dir, `${safeId(c.instance_id)}.json`),
      JSON.stringify(result, null, 2) + "\n",
    );
  }
}

export function contextFor(root: string, profile: string): { cfg: Config; ecosystem: Ecosystem } {
  const cfg = benchConfig(root, profile);
  return { cfg, ecosystem: ecosystemFor(loadProfileEcosystem(root, profile)) };
}
