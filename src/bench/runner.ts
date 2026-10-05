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
//   - memory: off. A benchmark of a foreign repo must not read the deployed
//     repo's memory, and a PR session's memory extension would also WRITE its turns
//     into reviewer memory (vendor/openviking-pi syncTurns).
//   - inject-bridge / tmux: a benchmark round is one `pi -p` process that
//     exits when the agent settles; there is no daemon to deliver wakes.
//   - GitHub/CI/posting: replaced by `benchAppendix` (see aacr.ts header).
//   - profile: generic ("") by default — the deployed profile's Django house
//     rules would be noise on a Rust PR. `--profile <config.toml [review]
//     profile>` measures production as deployed.

import { renderPassTasks } from "../passtasks.js";
import {
  postedRenderOptions,
  renderPostedReview,
  type PostedRenderConfig,
} from "../reviewrender.js";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  applyReviewEffort,
  loadConfig,
  parseConfig,
  parsePreset,
  validateLensKnobs,
  type Config,
  type ReviewPreset,
} from "../config.js";
import { buildRoundOrder } from "../dispatch.js";
import { locateConfig } from "../install.js";
import { findStyleGuide } from "../styleguide.js";
import { findCiLinters } from "../lintconfig.js";
import { ecosystemFor, type Ecosystem } from "../ecosystem.js";
import type { PrFileEntry } from "../github.js";
import { prepareDependencySources, renderDependencyNote } from "../depsources.js";
import {
  buildAgents,
  configAddenda,
  identityVars,
  passTierModels,
  PASS_ADDENDA,
} from "../include.js";
import { MEMORY_LESS } from "../memory/context.js";
import {
  applyProfileTuning,
  lensEnabled,
  lensModelOverrides,
  lensTuningAddenda,
  type LensTuning,
} from "../lenstuning.js";
import {
  loadProfileAddenda,
  loadProfileEcosystem,
  loadProfileHeuristics,
  loadProfileLensTuning,
  loadProfilePosting,
} from "../profiles.js";
import {
  applyProfilePosting,
  isDefaultPosting,
  postingPolicyAddenda,
  type PostingPolicy,
} from "../postingpolicy.js";
import { enforceBenchPosting, POLICED_ORIGINALS, type BenchPostingReport } from "./benchposting.js";
import { directiveVocabulary, isFirstPartyDirectivePath } from "../severity.js";
import type { PrStateRow } from "../state.js";
import type { PassPlanEntry } from "../types.js";
import {
  renderConversationSystemPrompt,
  renderGateNotes,
  renderRoundPrompt,
  roundTemplateFile,
} from "../templates.js";
import {
  benchAppendix,
  CASE_FILES,
  filesFromGitDiff,
  bodyPostedFindings,
  modelErrorsFromEvents,
  OVERLOAD_RE,
  RATE_LIMIT_RE,
  USAGE_LIMIT_RE,
  type ModelErrors,
  parseSessionComments,
  reanchorLeftComments,
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
import {
  apiKeyEnv,
  authFingerprint,
  benchAuthMode,
  modelForAuth,
  type BenchAuthMode,
} from "./auth.js";

export interface RunnerOptions {
  /** The production tree inside the image (`/opt/quickreview/sandbox`) — the
   * session's cwd, exactly as on the VM. */
  root: string;
  /** Prefetched per-instance object stores (read-only mount). */
  store: string;
  /** This run's output dir (the one host bind mount that is written). */
  outDir: string;
  /** pi's agent dir for this run: a PRIVATE tmpfs dir holding a copy of the
   * shared login with its refresh token disabled (src/bench/auth.ts). */
  agentDir: string;
  profile: string;
  timeoutMs: number;
  piBin?: string;
  keepTree?: boolean;
  log?: (line: string) => void;
}

export interface CaseSummary {
  instance_id: string;
  /** `no-verdict`: the round wrote its files but decided nothing (its pass
   * infrastructure failed) — not a review, so `--resume` runs it again. */
  status: "ok" | "no-verdict" | "no-output" | "timeout" | "failed";
  error?: string;
  /** What produced this case: `--resume` re-runs a case whose fingerprint
   * differs from the current run's, so one run never mixes builds. */
  fingerprint?: RunFingerprint;
  verdict: string | null;
  duration_seconds: number;
  usage: { input: number; output: number; cacheRead: number; children: number };
  planned_lenses: string[];
  executed_passes: string[];
  comments: {
    total: number;
    by_tag: Record<string, number>;
    left_side: number;
    /** LEFT-side comments moved to the head side of their hunk. */
    reanchored?: number;
    unparseable: number;
    /** Posted in the review body (no valid inline anchor) — scored too. */
    body: number;
  };
  pr_meta: { title: boolean; body: boolean; base_ref_source: string };
  diff: { files: number; additions: number; deletions: number };
  continued: boolean;
  /** pi's stderr warnings/errors, deduplicated — a degraded run (settings
   * ignored, an extension that failed to load) must be visible in the report,
   * not only in a log nobody opens. */
  warnings: string[];
  /** Failed model calls by kind (aacr.ts modelErrorsFromEvents, plus pi's
   * stderr): how arm.sh tells the shared login pushing back from a review
   * that genuinely failed. Absent on summaries written before 2026-09-27. */
  model_errors?: ModelErrors;
  /** What the profile's `[posting]` policy did to the session's output
   * (src/bench/benchposting.ts). Absent at today's posting. */
  posting?: BenchPostingReport;
}

/** Whether a finished case should be re-run: anything but `ok`, except a case
 * that can never run (not prefetched — a re-run fails the same way). */
export function retryable(s: Pick<CaseSummary, "status" | "error">): boolean {
  return s.status !== "ok" && !/not prefetched/.test(s.error ?? "");
}

/** The one machine-readable line a case ends with; arm.sh's scheduler reads
 * it (and nothing inside the run dir) to decide retries, rate-limit pauses
 * and its adaptive concurrency. `limited` counts rate-limit, overload and
 * usage-limit errors; `quota=N` (only when N > 0) says N of them were the
 * plan's usage window running out, which stops new launches outright. */
export function resultLine(s: CaseSummary, skipped = false): string {
  const e = s.model_errors;
  const quota = e?.usage_limit ?? 0;
  const limited = e ? e.rate_limited + e.overloaded + quota : 0;
  return `result: ${s.instance_id} ${s.status} retry=${retryable(s) ? 1 : 0} limited=${limited}${quota ? ` quota=${quota}` : ""}${skipped ? " skipped" : ""}`;
}

export interface RunFingerprint {
  qcr_commit: string;
  profile: string;
  /** `--config` levers this run set ("" = the shipped config). */
  overrides?: string;
  /** Present only on the API-key route (src/bench/auth.ts authFingerprint). */
  auth?: "api-key";
  conversation: string;
  tiers: Record<string, string>;
  validate_tier: string;
  pi: string;
  /** `[models] effort` and what "high" meant for this run. */
  effort?: { effort: string; effort_max: string };
  /** The review preset and the levers it resolved to (explicit keys included). */
  preset?: string;
  levers?: {
    sublenses: boolean;
    sweep: boolean;
    sweep_max_groups: number;
    sweep_group_files?: number;
    sweep_group_lines?: number;
    sweep_wide_files?: number;
    intent_min_words?: number;
    placement_min_code_files?: number;
    placement_min_new_file_lines?: number;
    dependency_sources: boolean;
    tests_lens: boolean;
    quality_lenses?: boolean;
    quality_min_added_lines?: number;
    style_lens?: boolean;
    nits?: string;
    validate_demote?: boolean;
    skip_lenses?: string[];
    validate_consequence_rule?: boolean;
  };
  /**: the profile's resolved per-lens tuning. Absent when untuned, so
   * an untuned run's fingerprint is what it was before per-lens tuning. A
   * profile style guide is recorded by name and content hash. */
  lenses?: Record<string, FingerprintLensTuning>;
  /** Per-lens tier pins (`[models.pass_tiers]`) and the risk passes. */
  pass_tiers?: Record<string, string>;
  risk_passes?: string[];
  /** The profile's `[posting]` policy. Absent at today's posting, so a run
   * without one keeps its fingerprint. */
  posting?: PostingPolicy;
}

type FingerprintLensTuning = Omit<LensTuning, "guide"> & {
  guide?: { file: string; sha256: string };
};

function fingerprintLenses(
  lenses: Readonly<Record<string, LensTuning>>,
): Record<string, FingerprintLensTuning> {
  const out: Record<string, FingerprintLensTuning> = {};
  for (const [lens, { guide, ...rest }] of Object.entries(lenses)) {
    out[lens] = {
      ...structuredClone(rest),
      ...(guide
        ? {
            guide: {
              file: guide.file,
              sha256: createHash("sha256").update(guide.text).digest("hex"),
            },
          }
        : {}),
    };
  }
  return out;
}

export function runFingerprint(cfg: Config, profile: string, overrides = ""): RunFingerprint {
  return {
    qcr_commit: process.env.QCR_BENCH_COMMIT ?? "unknown",
    profile,
    ...(overrides ? { overrides } : {}),
    ...authFingerprint(),
    conversation: cfg.models.conversation,
    tiers: { ...cfg.models.tiers },
    validate_tier: cfg.models.validate_tier,
    pass_tiers: { ...(cfg.models.pass_tiers ?? {}) },
    risk_passes: [...cfg.models.risk_passes],
    pi: cfg.pi.version,
    effort: { effort: cfg.models.effort, effort_max: cfg.models.effort_max },
    preset: cfg.review.preset,
    levers: {
      sublenses: cfg.review.sublenses,
      sweep: cfg.review.sweep,
      sweep_max_groups: cfg.review.sweep_max_groups,
      sweep_group_files: cfg.review.sweep_group_files,
      sweep_group_lines: cfg.review.sweep_group_lines,
      sweep_wide_files: cfg.review.sweep_wide_files,
      intent_min_words: cfg.review.intent_min_words,
      placement_min_code_files: cfg.review.placement_min_code_files,
      placement_min_new_file_lines: cfg.review.placement_min_new_file_lines,
      dependency_sources: cfg.review.dependency_sources,
      tests_lens: cfg.review.tests_lens,
      quality_lenses: cfg.review.quality_lenses,
      quality_min_added_lines: cfg.review.quality_min_added_lines,
      style_lens: cfg.review.style_lens,
      nits: cfg.review.nits,
      validate_demote: cfg.review.validate_demote,
      skip_lenses: [...(cfg.review.skip_lenses ?? [])],
      validate_consequence_rule: cfg.review.validate_consequence_rule ?? false,
    },
    ...(Object.keys(cfg.lenses ?? {}).length > 0 ? { lenses: fingerprintLenses(cfg.lenses!) } : {}),
    ...(isDefaultPosting(cfg.posting) ? {} : { posting: { ...cfg.posting! } }),
  };
}

/** Cut a PR body to a UTF-8 byte budget. The body is the one unbounded input
 * in the order, and it appears twice (the intent note and the override). */
export function boundBody(body: string | null, maxBytes = 20_000): string | null {
  if (body === null || Buffer.byteLength(body, "utf8") <= maxBytes) return body;
  const cut = Buffer.from(body, "utf8")
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/, "");
  return `${cut}\n…(truncated for the benchmark)`;
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
 * Escalation stays whatever it ships as (off), so no escalation note renders.
 * "Production config.toml" is the install locator's answer — inside
 * the bench image that is the copy bench.sh baked from the operator's own. */
export function benchConfig(profile: string): Config {
  const cfg = structuredClone(loadConfig(locateConfig().path));
  cfg.review.profile = profile;
  return cfg;
}

/**
 * `--config a.b=v,c.d=w`: one bench run's config levers, set on the loaded
 * production config — so two arms of one experiment share ONE image and differ
 * only in the knobs named on the command line (recorded in the fingerprint).
 * A key must already exist in the config (a typo fails loudly instead of
 * measuring nothing) — except inside an OPEN map (`OPEN_MAP_KEYS`, e.g.
 * `models.pass_tiers.pass-sweep=sol-high`), whose keys are data. `true`/`false`
 * and numbers are coerced to the type the key already holds; an array-valued
 * key takes `|`-separated items (`,` separates pairs), empty = `[]`.
 * `models.effort` is re-applied to every model spec, and the per-lens knobs
 * are re-validated exactly as config parsing validates them.
 */
/** Config maps whose keys are data rather than schema — `--config` may add a
 * key to them. Every other path must already exist. */
export const OPEN_MAP_KEYS: ReadonlySet<string> = new Set(["models.pass_tiers"]);
/** The config text with `[review] preset` set to `preset` — replaced when the
 * section already names one, inserted under the section header otherwise. */
export function withPresetInToml(toml: string, preset: ReviewPreset): string {
  const lines = toml.split("\n");
  const head = lines.findIndex((l) => /^\[review\]\s*$/.test(l));
  if (head < 0) return `${toml}\n[review]\npreset = "${preset}"\n`;
  let end = lines.findIndex((l, i) => i > head && /^\[/.test(l));
  if (end < 0) end = lines.length;
  for (let i = head + 1; i < end; i++)
    if (/^\s*preset\s*=/.test(lines[i] as string)) {
      lines[i] = `preset = "${preset}"`;
      return lines.join("\n");
    }
  lines.splice(head + 1, 0, `preset = "${preset}"`);
  return lines.join("\n");
}

/**
 * `--config a.b=v,c.d=w`: one bench run's levers (see above). `review.preset=X`
 * means "as if config.toml said `preset = X`": the config TEXT is re-parsed
 * with that preset, so the preset resolves exactly as in production — its
 * reasoning level replaces whatever level the file's own preset baked into the
 * specs, and a key the file sets explicitly still beats it. It therefore needs
 * the config text (`toml`); every other pair then overrides on top.
 */
export function applyConfigOverrides(cfg: Config, spec: string, toml?: string): Config {
  const pairs = spec
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (pairs.length === 0) return cfg;
  const keyOf = (p: string): string => p.slice(0, Math.max(p.indexOf("="), 0)).trim();
  const presetPairs = pairs.filter((p) => keyOf(p) === "review.preset");
  if (presetPairs.length > 1) throw new Error("--config: review.preset given more than once");
  const presetPair = presetPairs[0];
  let base = cfg;
  if (presetPair) {
    const preset = parsePreset(presetPair.slice(presetPair.indexOf("=") + 1));
    if (toml === undefined)
      throw new Error("--config: review.preset needs the config text to re-parse");
    base = parseConfig(withPresetInToml(toml, preset));
    base.review.profile = cfg.review.profile;
  }
  const rest = pairs.filter((p) => p !== presetPair);
  if (rest.length === 0) return base;
  const out = structuredClone(base) as unknown as Record<string, unknown>;
  for (const pair of rest) {
    const eq = pair.indexOf("=");
    if (eq <= 0) throw new Error(`--config: "${pair}" is not key=value`);
    const path = pair.slice(0, eq).trim().split(".");
    const raw = pair.slice(eq + 1).trim();
    let node = out;
    for (const k of path.slice(0, -1)) {
      const next = node[k];
      if (typeof next !== "object" || next === null)
        throw new Error(`--config: no section "${path.join(".")}" in config.toml`);
      node = next as Record<string, unknown>;
    }
    const leaf = path[path.length - 1] as string;
    const open = OPEN_MAP_KEYS.has(path.slice(0, -1).join("."));
    if (!open && !Object.hasOwn(node, leaf))
      throw new Error(`--config: no key "${path.join(".")}" in config.toml`);
    const cur = node[leaf];
    const num = (v: string): number => {
      const n = Number(v);
      if (v === "" || !Number.isFinite(n))
        throw new Error(`--config: ${path.join(".")} takes a number (got "${v}")`);
      return n;
    };
    if (Array.isArray(cur)) {
      const items = raw === "" ? [] : raw.split("|").map((x) => x.trim());
      if (items.some((x) => x === ""))
        throw new Error(`--config: ${path.join(".")} has an empty item in "${raw}"`);
      node[leaf] = cur.length > 0 && typeof cur[0] === "number" ? items.map(num) : items;
      continue;
    }
    if (typeof cur === "object" && cur !== null)
      throw new Error(
        `--config: ${path.join(".")} is a table — set one of its keys (${path.join(".")}.<key>=…)`,
      );
    node[leaf] =
      typeof cur === "boolean"
        ? raw === "true"
          ? true
          : raw === "false"
            ? false
            : (() => {
                throw new Error(`--config: ${path.join(".")} takes true|false`);
              })()
        : typeof cur === "number"
          ? num(raw)
          : raw;
  }
  const next = out as unknown as Config;
  if (rest.some((p) => p.startsWith("models.effort"))) {
    const effort = next.models.effort;
    // Re-parse through the same validation the config file gets.
    next.models = applyReviewEffort({
      ...next.models,
      effort: (["", "low", "medium", "high"] as const).includes(effort)
        ? effort
        : effort === ("med" as string)
          ? "medium"
          : (() => {
              throw new Error(`--config: models.effort must be low|medium|high (got ${effort})`);
            })(),
    });
  }
  validateLensKnobs(next);
  return next;
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
    // The bench round runs without the memory extension (header: memory off).
    memory: false,
    root,
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    validateTier: cfg.models.validate_tier,
    vars: identityVars(cfg),
    ecosystem: loadProfileEcosystem(root, cfg.review.profile),
    models: passTierModels(
      cfg.models.pass_tiers,
      cfg.models.tiers,
      lensModelOverrides(cfg.models, cfg.lenses),
    ),
    addenda: [
      ...PASS_ADDENDA,
      ...configAddenda(cfg.review),
      ...loadProfileAddenda(root, cfg.review.profile),
      ...lensTuningAddenda(cfg.lenses),
      // The profile's `[posting]` policy, compiled for the validator.
      ...postingPolicyAddenda(cfg.posting),
    ],
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
export async function prepareTree(store: string, tree: string, meta: PrefetchMeta): Promise<void> {
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
  /** The rendered third-party-sources block, "" when none (depsources.ts). */
  dependencyNote?: string;
}): {
  system: string;
  order: string;
  plannedLenses: string[];
  passPlan: PassPlanEntry[];
  /** `[review] task_files`: the lens task files the order points at, for the
   * caller to write before the session starts. */
  taskFiles: Array<{ path: string; text: string }>;
} {
  const { root, cfg, c, meta, tree } = args;
  const identity = { ...identityVars(cfg), repo: c.repo };
  const title = meta.title ?? `AACR-Bench ${c.repo}#${c.pr}`;
  const body = boundBody(meta.body);
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
  const built = buildRoundOrder({
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
    ...(body !== null ? { prBody: body } : {}),
    ...(directiveFiles.length
      ? { firstPartyDirectives: { files: directiveFiles, mention: "maintainer" } }
      : {}),
    ecosystem: args.ecosystem,
    heuristics: loadProfileHeuristics(root, cfg.review.profile),
    ...(args.dependencyNote ? { dependencyNote: args.dependencyNote } : {}),
    // The repo's written style guide, as production finds it (dispatch.ts).
    ...(lensEnabled(cfg.lenses, "pass-style", cfg.review.style_lens)
      ? { styleGuide: findStyleGuide(tree) }
      : {}),
    // The linters a CI job of the repo runs, as production finds them.
    ...(lensEnabled(cfg.lenses, "pass-lint-conformance", cfg.review.lint_conformance)
      ? { ciLinters: findCiLinters(tree) }
      : {}),
  });
  // `[review] task_files`, as production writes them (dispatch.ts): one
  // complete lens task per discovery row, in the case dir.
  // Rendered here, written by the caller (renderCasePrompts stays pure).
  const taskFiles = cfg.review.task_files
    ? renderPassTasks(built, renderGateNotes(built, args.ecosystem)).map((t) => ({
        ...t,
        path: join(args.caseDir, "tasks", t.file),
      }))
    : [];
  // The bench renders comments.json and review.md itself after the session
  // (`[review] render_outputs`, benchAppendix), so the order never carries
  // production's render-review.sh note: the replay has no scripts/.
  const { render_outputs: _renderedByBench, ...unrendered } = built;
  const order = taskFiles.length
    ? {
        ...unrendered,
        pass_task_files: taskFiles.map((t) => ({ row: t.row, agent: t.agent, path: t.path })),
      }
    : unrendered;
  const template = readFileSync(join(root, "prompts", roundTemplateFile("first")), "utf8");
  const rendered = renderRoundPrompt(
    template,
    order,
    MEMORY_LESS,
    cfg.owner.name,
    args.ecosystem,
    identity,
  );
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
      ...(cfg.review.render_outputs ? { renderOutputs: true } : {}),
    });
  const system = renderConversationSystemPrompt(
    readFileSync(join(root, "prompts", "conversation-system.md"), "utf8"),
    { pr: c.pr, title, worktree: tree },
    identity,
  );
  return {
    system,
    order: orderText,
    plannedLenses: order.pass_plan.map((p) => p.agent),
    passPlan: order.pass_plan,
    taskFiles: taskFiles.map((t) => ({ path: t.path, text: t.text })),
  };
}

export interface PiRun {
  code: number | null;
  timedOut: boolean;
  streamError: string | null;
}

/** The bench's ONE pi spawn (tests/single-shepherd.test.ts S2): the review
 * round and the defect judge (defectjudge.ts) both go through it. */
export function runPi(
  argv: string[],
  env: NodeJS.ProcessEnv,
  cwd: string,
  eventsPath: string,
  stderrPath: string,
  timeoutMs: number,
  piBin: string,
  stdinText?: string,
): Promise<PiRun> {
  return new Promise((resolve) => {
    const events = createWriteStream(eventsPath, { flags: "a" });
    const errs = createWriteStream(stderrPath, { flags: "a" });
    // detached: its own process group, so a timeout kills the lens children
    // with it rather than orphaning six pi processes on the model API.
    const child = spawn(piBin, argv, {
      cwd,
      env,
      stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      detached: true,
    });
    let timedOut = false;
    let streamError: string | null = null;
    const kill = (sig: NodeJS.Signals): void => {
      try {
        if (child.pid) process.kill(-child.pid, sig);
      } catch {
        // already gone
      }
    };
    // A full disk must end THIS case as a recorded failure, not throw out of
    // the CLI and lose every case after it.
    const onStreamError = (e: Error): void => {
      streamError = String(e);
      kill("SIGKILL");
    };
    events.on("error", onStreamError);
    errs.on("error", onStreamError);
    // The round order goes in on stdin: pi -p takes piped stdin as the prompt,
    // and an argv string caps at 128 KiB (MAX_ARG_STRLEN).
    // A pi that dies before reading its prompt (bad model, auth refusal)
    // EPIPEs this write asynchronously: unheard, that error kills the CLI.
    if (stdinText !== undefined && child.stdin) {
      child.stdin.on("error", (e) => onStreamError(new Error(`prompt delivery: ${String(e)}`)));
      child.stdin.end(stdinText);
    }
    // `*_update` events re-emit a lens child's whole transcript on every
    // update — the file grows quadratically. Nothing reads them: usage comes
    // from `message_end` and `tool_execution_end`.
    const lines = createInterface({ input: child.stdout! });
    lines.on("line", (line) => {
      if (
        line.startsWith('{"type":"tool_execution_update"') ||
        line.startsWith('{"type":"message_update"')
      )
        return;
      events.write(line + "\n");
    });
    child.stderr!.pipe(errs);
    const timer = setTimeout(() => {
      timedOut = true;
      kill("SIGTERM");
      setTimeout(() => kill("SIGKILL"), 15_000).unref();
    }, timeoutMs);
    child.on("error", (e) => {
      errs.write(`spawn error: ${String(e)}\n`);
    });
    // Resolve only once both files are flushed and closed: every caller reads
    // them synchronously the moment this resolves (the judge's answer is the
    // events file's LAST message_end).
    child.on("close", (code) => {
      clearTimeout(timer);
      let open = 2;
      const settled = (): void => {
        if (--open === 0) resolve({ code, timedOut, streamError });
      };
      for (const s of [events, errs]) {
        if (s.closed) settled();
        else {
          s.once("close", settled);
          s.end();
        }
      }
    });
  });
}

/**
 * The bench's render step (`[review] render_outputs`): the SAME two calls the
 * live route's scripts/render-review.sh makes (src/reviewrendercli.ts
 * renderRound) — `postedRenderOptions(cfg)` then `renderPostedReview` — with
 * the case's outcome as the fallback verdict, summary and lenses line. Pinned
 * equal to the live route by tests/dedup-parity.test.ts.
 */
export function renderBenchOutputs(
  record: unknown,
  outcome: Record<string, unknown> | undefined,
  cfg: PostedRenderConfig,
): ReturnType<typeof renderPostedReview> {
  const passes = Array.isArray(outcome?.["passes"])
    ? (outcome["passes"] as Array<Record<string, unknown>>)
        .map((p) => String(p["name"] ?? ""))
        .filter((n) => n && n !== "pass-validate")
    : [];
  return renderPostedReview(
    record,
    postedRenderOptions(cfg, {
      verdict: typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null,
      summary: typeof outcome?.["summary"] === "string" ? outcome["summary"] : null,
      lensesApplied: passes.length ? passes.join(", ") : null,
    }),
  );
}

/**
 * The defect judge's pi argv (src/bench/defectjudge.ts): no session, no
 * skills/templates/context files, no project-local files, no extension but the
 * no-exec bash guard, and only the \`read\` and \`bash\` tools. The judge reads
 * code to check a claim; it never runs it and never writes.
 */
export function judgePiArgv(root: string, model: string): string[] {
  return [
    "-p",
    "--no-session",
    "--no-approve",
    "--no-extensions",
    "--extension",
    join(root, "extensions", "bash-guard.ts"),
    "--tools",
    "read,bash",
    "--no-skills",
    "--no-context-files",
    "--no-prompt-templates",
    "--no-themes",
    "--model",
    model,
    "--mode",
    "json",
  ];
}

/** One judge session: \`pi\` from the env's PATH, the prompt on stdin. */
export function runJudgeSession(
  prompt: string,
  o: {
    root: string;
    cwd: string;
    model: string;
    env: NodeJS.ProcessEnv;
    eventsPath: string;
    timeoutMs: number;
  },
): Promise<PiRun> {
  return runPi(
    judgePiArgv(o.root, o.model),
    o.env,
    o.cwd,
    o.eventsPath,
    o.eventsPath.replace(/\.jsonl$/, ".stderr.log"),
    o.timeoutMs,
    "pi",
    prompt,
  );
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
  ctx: { cfg: Config; ecosystem: Ecosystem; fingerprint: RunFingerprint },
): Promise<CaseSummary> {
  const log = o.log ?? (() => {});
  const safe = safeId(c.instance_id);
  const caseDir = join(o.outDir, "cases", safe);
  const tree = join(o.root, "wt", safe);
  // pi's spill files (bash output, subagent temp) land here, on the disk-backed
  // wt volume — not in /tmp, a tmpfs charged to the container's memory cap.
  const tmpDir = join(o.root, "wt", `${safe}.tmp`);
  mkdirSync(caseDir, { recursive: true });
  for (const f of [...Object.values(CASE_FILES), ...POLICED_ORIGINALS])
    rmSync(join(caseDir, f), { force: true });
  const started = Date.now();
  const summary: CaseSummary = {
    instance_id: c.instance_id,
    status: "failed",
    fingerprint: ctx.fingerprint,
    verdict: null,
    duration_seconds: 0,
    usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
    planned_lenses: [],
    executed_passes: [],
    comments: { total: 0, by_tag: {}, left_side: 0, unparseable: 0, body: 0 },
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
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
    const files = await changedFiles(tree, meta);
    // Third-party sources, exactly as the daemon's dispatch unpacks them
    // (`[review] dependency_sources`): one cache per run container, on the
    // disk-backed wt volume, shared by concurrent cases. What was unpacked and
    // what was skipped is kept per case (deps.json) — the attribution record.
    rmSync(join(caseDir, "deps.json"), { force: true });
    let dependencyNote = "";
    if (ctx.cfg.review.dependency_sources) {
      const manifest = await prepareDependencySources(tree, files, {
        cacheDir: join(o.root, "wt", ".depcache"),
        log: (line) => log(`deps: ${c.instance_id}: ${line}`),
      });
      writeFileSync(join(caseDir, "deps.json"), JSON.stringify(manifest, null, 2));
      dependencyNote = renderDependencyNote(manifest);
    }
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
      dependencyNote,
    });
    summary.planned_lenses = prompts.plannedLenses;
    writeFileSync(join(caseDir, "pass-plan.json"), JSON.stringify(prompts.passPlan, null, 2));
    if (prompts.taskFiles.length) {
      mkdirSync(join(caseDir, "tasks"), { recursive: true });
      for (const t of prompts.taskFiles) writeFileSync(t.path, t.text);
    }
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
      TMPDIR: tmpDir,
      LANG: "C.UTF-8",
      PI_CODING_AGENT_DIR: o.agentDir,
      QCR_SUBAGENT_SCOPE: "project",
      QCR_SUBAGENT_MAX_CONCURRENCY: String(ctx.cfg.pi.subagent_max_concurrency),
      QCR_SUBAGENT_WIDE_FANOUT: ctx.cfg.review?.wide_lens_fanout === false ? "0" : "1",
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
      // An `anthropic/` model arm: pi's anthropic provider reads this key. bench.sh
      // passes it by --env-file only when --config names an anthropic/ model.
      ...(process.env.ANTHROPIC_API_KEY
        ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
        : {}),
      // The API-key route (src/bench/auth.ts): OPENAI_API_KEY for the `openai/`
      // specs, from bench.sh's --env-file. Nothing on the login route.
      ...apiKeyEnv(),
    };
    const sessionDir = join(caseDir, "session");
    // This attempt's session only: an earlier attempt's JSONL left here would
    // make `resumable` true and `--continue` would resume THAT conversation.
    rmSync(sessionDir, { recursive: true, force: true });
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
      // The live PR session's `cluster_findings` tool (src/sessions.ts
      // extensionPaths): the same grouping code on both routes.
      "--extension",
      join(o.root, "extensions", "finding-clusters.ts"),
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
      [...base, "-p"],
      env,
      o.root,
      events,
      stderr,
      o.timeoutMs,
      piBin,
      prompts.order,
    );
    const outcomePath = join(caseDir, CASE_FILES.outcome);
    // One continuation, never more: the live system's answer to a round that
    // stopped short is redelivery, not a fresh review (#5362). Same session —
    // and only if there IS one: pi persists a session after its first
    // assistant message, and `--continue` on an empty session dir silently
    // starts a NEW session that would review with no round order at all.
    const resumable =
      existsSync(sessionDir) && readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
    if (!r.timedOut && !r.streamError && !existsSync(outcomePath) && !resumable) {
      summary.error = `pi exited ${String(r.code)} before any assistant message — nothing to continue`;
    }
    if (!r.timedOut && !r.streamError && !existsSync(outcomePath) && resumable) {
      const left = o.timeoutMs - (Date.now() - started);
      if (left > 120_000) {
        summary.continued = true;
        log(`review: ${c.instance_id} — no outcome.json yet, one continuation`);
        r = await runPi(
          [
            ...base,
            "--continue",
            "-p",
            ctx.cfg.review.render_outputs
              ? `You stopped before the BENCHMARK MODE files were complete. Finish the round now and write ${CASE_FILES.findings} (with the posting fields) and, last, ${CASE_FILES.outcome} in ${caseDir}.`
              : `You stopped before the BENCHMARK MODE files were complete. Finish the round now and write ${CASE_FILES.comments}, ${CASE_FILES.review}, ${CASE_FILES.findings} and, last, ${CASE_FILES.outcome} in ${caseDir}.`,
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
    if (r.streamError) summary.error = `output stream failed: ${r.streamError}`;
    // Usage is telemetry: a failure to read it must never cost the review.
    try {
      const lines = readFileSync(events, "utf8").split("\n");
      summary.usage = usageFromEvents(lines);
      summary.model_errors = modelErrorsFromEvents(lines);
      // pi's own stderr reports what never reached a message (a refused
      // connection, a 429 before the first token).
      for (const w of summary.warnings) {
        if (USAGE_LIMIT_RE.test(w))
          summary.model_errors.usage_limit = (summary.model_errors.usage_limit ?? 0) + 1;
        else if (RATE_LIMIT_RE.test(w)) summary.model_errors.rate_limited++;
        else if (OVERLOAD_RE.test(w)) summary.model_errors.overloaded++;
      }
    } catch (err) {
      summary.warnings.push(`usage unreadable: ${String(err).slice(0, 200)}`);
    }
    const outcome = readJson(outcomePath) as Record<string, unknown> | undefined;
    // `[review] render_outputs`: comments.json and review.md rendered from the
    // findings record, as production's render-review.sh renders them. A
    // session that wrote its own files anyway is overruled: the record is the
    // source.
    let renderedPosting: BenchPostingReport | undefined;
    if (ctx.cfg.review.render_outputs) {
      const record = readJson(join(caseDir, CASE_FILES.findings));
      if (record !== undefined) {
        const out = renderBenchOutputs(record, outcome, ctx.cfg);
        writeFileSync(
          join(caseDir, CASE_FILES.comments),
          JSON.stringify(out.rendered.comments, null, 2) + "\n",
        );
        writeFileSync(join(caseDir, CASE_FILES.review), out.rendered.body);
        // The duplicate-merge post-check's and the posting policy's
        // dispositions, kept in the record (the session's own beside it).
        if (out.record !== record) {
          writeFileSync(
            join(caseDir, POLICED_ORIGINALS[2]),
            JSON.stringify(record, null, 2) + "\n",
          );
          writeFileSync(
            join(caseDir, CASE_FILES.findings),
            JSON.stringify(out.record, null, 2) + "\n",
          );
        }
        // The `[posting]` cut ran inside the render step, as on the live
        // route — so enforceBenchPosting below must not cut a second time.
        if (!isDefaultPosting(ctx.cfg.posting)) {
          renderedPosting = {
            kept: out.rendered.comments.length + out.rendered.in_body,
            withheld: out.withheld.map((w) => ({
              path: w.path ?? "",
              line: w.line ?? 0,
              source: w.inline ? ("inline" as const) : ("body" as const),
              cls: w.cls,
              severity: w.severity,
              word: w.word,
              title: w.title,
            })),
            body: ctx.cfg.posting!.body,
          };
          writeFileSync(
            join(caseDir, POLICED_ORIGINALS[3]),
            JSON.stringify(renderedPosting, null, 2) + "\n",
          );
        }
        if (out.rendered.problems.length)
          summary.warnings.push(
            ...out.rendered.problems.slice(0, 10).map((p) => `render: ${p}`.slice(0, 300)),
          );
      }
    }
    // The profile's `[posting]` policy, applied to what the session wrote
    // exactly as production posting applies it: an over-posting session is
    // still cut, and what is cut is recorded `withheld` (originals kept beside).
    if (renderedPosting) {
      summary.posting = renderedPosting;
      log(
        `review: ${c.instance_id} — posting policy kept ${renderedPosting.kept} of ${renderedPosting.kept + renderedPosting.withheld.length} (${renderedPosting.withheld.map((w) => w.word).join(", ") || "nothing withheld"})`,
      );
    } else if (!isDefaultPosting(ctx.cfg.posting) && outcome !== undefined) {
      const patches: Record<string, string> = {};
      for (const f of files) if (f.patch !== undefined) patches[f.filename] = f.patch;
      const policed = enforceBenchPosting(caseDir, ctx.cfg.posting!, patches);
      if (policed) {
        summary.posting = policed;
        log(
          `review: ${c.instance_id} — posting policy kept ${policed.kept} of ${policed.kept + policed.withheld.length} (${policed.withheld.map((w) => w.word).join(", ") || "nothing withheld"})`,
        );
      }
    }
    const rawComments = readJson(join(caseDir, CASE_FILES.comments));
    const collected = collectComments(caseDir);
    // A comment the session anchored on a DELETED line is moved to the head
    // side of its hunk: every scorer the bench feeds reads head-side lines
    // only, and the comment was otherwise dropped whole (reanchorLeftComments).
    const headPatches: Record<string, string> = {};
    for (const f of files) if (f.patch !== undefined) headPatches[f.filename] = f.patch;
    const moved = reanchorLeftComments(collected.comments, headPatches);
    comments = moved.comments;
    summary.comments.reanchored = moved.reanchored;
    summary.comments.unparseable = collected.dropped;
    summary.comments.body = collected.body;
    summary.verdict = typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null;
    summary.executed_passes = Array.isArray(outcome?.["passes"])
      ? (outcome["passes"] as Array<Record<string, unknown>>).map(
          (p) => `${String(p["name"])}--${String(p["tier"])}`,
        )
      : [];
    summary.status = r.timedOut
      ? "timeout"
      : outcome === undefined || rawComments === undefined
        ? "no-output"
        : summary.verdict === "APPROVE" || summary.verdict === "REQUEST_CHANGES"
          ? "ok"
          : "no-verdict";
  } catch (err) {
    summary.status = "failed";
    summary.error = String(err instanceof Error ? err.message : err).slice(0, 2000);
    log(`review: ${c.instance_id} FAILED — ${summary.error}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
    if (!o.keepTree) rmSync(tree, { recursive: true, force: true });
  }
  summary.duration_seconds = Math.round((Date.now() - started) / 1000);
  summary.comments.total = comments.length;
  summary.comments.left_side = comments.filter((x) => x.side === "LEFT").length;
  for (const x of comments)
    summary.comments.by_tag[x.tag] = (summary.comments.by_tag[x.tag] ?? 0) + 1;
  writeFileSync(join(caseDir, "case-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeResults(o.outDir, c, comments, summary);
  const me = summary.model_errors;
  const errs =
    me && me.rate_limited + me.overloaded + (me.usage_limit ?? 0) + me.other > 0
      ? `; model errors: ${me.rate_limited} rate-limited, ${me.overloaded} overloaded, ${me.usage_limit ?? 0} usage-limit, ${me.other} other${summary.status !== "ok" && (me.usage_limit ?? 0) > 0 ? " — USAGE LIMIT REACHED" : summary.status !== "ok" && me.rate_limited + me.overloaded > 0 ? " — RATE-LIMITED" : ""}`
      : "";
  log(
    `review: ${c.instance_id} ${summary.status} — verdict ${summary.verdict ?? "none"}, ${comments.length} comment(s), ${summary.duration_seconds}s${errs}`,
  );
  return summary;
}

/** Everything this case POSTED, as scored comments: the inline comments the
 * session wrote, plus the findings its record marks posted that went into the
 * review body for want of an inline anchor. The one reader of a case dir's
 * output, shared by a live run and `cli results` so a rebuild scores the same. */
export function collectComments(caseDir: string): {
  comments: BenchComment[];
  dropped: number;
  body: number;
} {
  const parsed = parseSessionComments(readJson(join(caseDir, CASE_FILES.comments)));
  let reviewMd = "";
  try {
    reviewMd = readFileSync(join(caseDir, CASE_FILES.review), "utf8");
  } catch {
    // no body written — body findings fall back to the record's own text
  }
  const inBody = bodyPostedFindings(
    readJson(join(caseDir, CASE_FILES.findings)),
    reviewMd,
    parsed.comments,
  );
  return {
    comments: [...parsed.comments.map((c) => ({ ...c, source: "inline" as const })), ...inBody],
    dropped: parsed.dropped,
    body: inBody.length,
  };
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

export function contextFor(
  root: string,
  profile: string,
  overrides = "",
): { cfg: Config; ecosystem: Ecosystem } {
  const levered = applyConfigOverrides(
    benchConfig(profile),
    overrides,
    readFileSync(locateConfig().path, "utf8"),
  );
  // The profile the run reviews under: `--profile`, or `--config
  // review.profile=<name>` (arm.sh's spelling) — every loader reads the same
  // one, so a profile chosen either way is the whole profile.
  const chosen = levered.review.profile;
  // the profile's lens tuning (and its `[posting]` policy) is
  // overlaid LAST — after the `--config` levers and any preset re-parse —
  // exactly as production overlays it after config.toml: the profile wins.
  const cfg = withAuthModels(
    applyProfilePosting(
      applyProfileTuning(levered, loadProfileLensTuning(root, chosen)),
      loadProfilePosting(root, chosen),
    ),
  );
  return { cfg, ecosystem: ecosystemFor(loadProfileEcosystem(root, chosen)) };
}

/** Every model spec of the config as it runs on the bench's credential route
 * (src/bench/auth.ts): on the API-key route `openai-codex/` → `openai/`, the
 * same model on the public API; on the login route the config unchanged. */
export function withAuthModels(cfg: Config, mode: BenchAuthMode = benchAuthMode()): Config {
  if (mode !== "api-key") return cfg;
  const out = structuredClone(cfg);
  const m = out.models;
  m.default = modelForAuth(m.default, mode);
  m.conversation = modelForAuth(m.conversation, mode);
  m.overseer = modelForAuth(m.overseer, mode);
  for (const k of Object.keys(m.tiers) as (keyof typeof m.tiers)[])
    m.tiers[k] = modelForAuth(m.tiers[k], mode);
  return out;
}
