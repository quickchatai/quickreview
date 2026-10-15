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

import { sweepStatusOf, type SweepStatus } from "../sweepstatus.js";
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
import { delimiter, dirname, join } from "node:path";
import {
  applyReviewEffort,
  loadConfig,
  parseConfig,
  parsePreset,
  validateLensKnobs,
  type Config,
  type ReviewPreset,
} from "../config.js";
import {
  buildPassPlan,
  buildRoundOrder,
  renderDeltaPatch,
  roundDeltaOf,
  sweepOrderOf,
  optionalOrderOf,
} from "../dispatch.js";
import { parseLedgerCarry, settledFromLedger } from "../ledgercarry.js";
import type { PrOwnedDelta } from "../worktrees.js";
import { benchDelta, benchPriorFindings, decideBenchFollowUp } from "./followup.js";
import { locateConfig } from "../install.js";
import { findStyleGuide } from "../styleguide.js";
import { findCiLinters } from "../lintconfig.js";
import { ecosystemFor, type Ecosystem } from "../ecosystem.js";
import type { PrFileEntry } from "../github.js";
import { CONTEXT_PACK_FILE, readWorktreeFileForPack, renderContextPack } from "../contextpack.js";
import { prepareDependencySources, renderDependencyNote } from "../depsources.js";
import {
  buildAgents,
  configAddenda,
  identityVars,
  passTierModels,
  sweepLightVariants,
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
import type { PassPlanEntry, RoundOrder } from "../types.js";
import {
  renderConversationSystemPrompt,
  renderGateNotes,
  renderRoundPrompt,
  roundTemplateFile,
  templateFileForOrder,
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
  stagesFromEvents,
  type Stages,
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
   * that genuinely failed. Absent on older summaries. */
  model_errors?: ModelErrors;
  /** What the profile's `[posting]` policy did to the session's output
   * (src/bench/benchposting.ts). Absent at the default posting. */
  posting?: BenchPostingReport;
  /** A follow-up replay case — what it ran as (delta or full, and
   * why). Absent on every other case. */
  follow_up?: CaseFollowUp;
  /** Per-phase subagent totals (aacr.ts stagesFromEvents; the per-call rows
   * are in the case's stages.json). Absent on older summaries. */
  stages?: Stages["phases"];
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
  inference?: { provider: "digitalocean" | "google"; config_sha256: string };
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
    /** The follow-up knobs, recorded only when they differ from the shipped
     * default, so a run at the default keeps its fingerprint. */
    follow_up?: string;
    follow_up_max_delta_ratio?: number;
    follow_up_sweep?: boolean;
    /** The baseline split threshold, recorded only when it differs
     * from the shipped default (2000). */
    baseline_split_lines?: number;
    /** Each set only when it differs from the shipped default: a light sweep
     * tier is named, or the validator's compact decision table is off. */
    sweep_light_tier?: string;
    validate_compact?: boolean;
  };
  /** The profile's resolved per-lens tuning. Absent when untuned, so an
   * untuned run's fingerprint carries no tuning field. A profile style guide
   * is recorded by name and content hash. */
  lenses?: Record<string, FingerprintLensTuning>;
  /** Per-lens tier pins (`[models.pass_tiers]`) and the risk passes. */
  pass_tiers?: Record<string, string>;
  /** Per-lens model overrides (`[models.pass_models]`). Absent when
   * none, so a run without one keeps its fingerprint. */
  pass_models?: Record<string, string>;
  risk_passes?: string[];
  /** The profile's `[posting]` policy. Absent at the default posting, so a run
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
    ...(Object.keys(cfg.models.pass_models ?? {}).length > 0
      ? { pass_models: { ...cfg.models.pass_models } }
      : {}),
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
      ...((cfg.review.follow_up ?? "delta") !== "delta" ? { follow_up: cfg.review.follow_up } : {}),
      ...((cfg.review.follow_up_max_delta_ratio ?? 0.6) !== 0.6
        ? { follow_up_max_delta_ratio: cfg.review.follow_up_max_delta_ratio }
        : {}),
      ...((cfg.review.follow_up_sweep ?? true) !== true
        ? { follow_up_sweep: cfg.review.follow_up_sweep }
        : {}),
      ...((cfg.review.baseline_split_lines ?? 2000) !== 2000
        ? { baseline_split_lines: cfg.review.baseline_split_lines }
        : {}),
      ...(cfg.review.sweep_light_tier ? { sweep_light_tier: cfg.review.sweep_light_tier } : {}),
      ...(cfg.review.validate_compact === false ? { validate_compact: false } : {}),
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
export const OPEN_MAP_KEYS: ReadonlySet<string> = new Set([
  "models.pass_tiers",
  "models.pass_models",
]);
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
      cfg.models.pass_models,
      sweepLightVariants(cfg.review),
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
  // A follow-up case: the head the previous round reviewed — the
  // delta's from side. It is the PR's past, never its future.
  if (meta.prev_head) await git(tree, ["update-ref", "refs/bench/prev-head", meta.prev_head]);
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

/** `[review] context_pack = "pack-first"`, as dispatch writes it:
 * the case's context pack beside its task dirs (`<case>/context-pack.md` —
 * where the glue looks for a task file's pack), and the order the task files
 * render from, which then points at it. Off ⇒ the order unchanged, no file. */
function benchContextPack(
  cfg: Config,
  built: RoundOrder,
  files: PrFileEntry[],
  tree: string,
  caseDir: string,
  deltaPatch?: string,
): { order: RoundOrder; file?: { path: string; text: string } } {
  if (
    !cfg.review.task_files ||
    cfg.review.context_pack !== "pack-first" ||
    cfg.pi.subagent_cache_group <= 0
  )
    return { order: built };
  const path = join(caseDir, CONTEXT_PACK_FILE);
  const pack = renderContextPack({
    pr: built.pr,
    headSha: built.head_sha,
    mergeBase: built.merge_base,
    files,
    ...(deltaPatch ? { deltaPatch } : {}),
    readFile: (p) => readWorktreeFileForPack(tree, p),
    maxTokens: cfg.review.context_pack_max_tokens,
  });
  return { order: { ...built, context_pack_file: path }, file: { path, text: pack.text } };
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
  /** A follow-up case: the PR-owned delta `benchDelta` computed over
   * the tree (undefined = none could be — the round runs in full). */
  followUpDelta?: PrOwnedDelta;
}): CasePrompts {
  if (args.c.followup) return renderFollowUpPrompts(args);
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
  const packed = benchContextPack(cfg, built, args.files, tree, args.caseDir);
  const taskFiles = cfg.review.task_files
    ? renderPassTasks(packed.order, renderGateNotes(built, args.ecosystem)).map((t) => ({
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
    ...(packed.file ? { contextPack: packed.file } : {}),
  };
}

export interface CasePrompts {
  system: string;
  order: string;
  plannedLenses: string[];
  passPlan: PassPlanEntry[];
  /** `[review] task_files`: the lens task files the order points at, for the
   * caller to write before the session starts. */
  taskFiles: Array<{ path: string; text: string }>;
  /** The case's context pack, for the caller to write (absent ⇒
   * remove any stale one). */
  contextPack?: { path: string; text: string };
  /** A follow-up case only: every other file the order names (the
   * delta patch, the prior-findings sidecar, the sweep's task files, the
   * pinned ledger), for the caller to write; what the round runs as; and the
   * pre-approval sweep's plan when one is owed. */
  extraFiles?: Array<{ path: string; text: string }>;
  followUp?: CaseFollowUp;
  sweepPlan?: PassPlanEntry[];
}

/** What a follow-up case ran as (CaseSummary.follow_up). */
export interface CaseFollowUp {
  round_no: number;
  review_no: number;
  /** `delta`: the follow-up round; `full`: a full re-review. */
  scope: "delta" | "full";
  /** Why the round runs in full (dispatch's `followup_full_round` reasons). */
  reason?: string;
  detail?: Record<string, unknown>;
  delta_lines?: number;
  delta_files?: number;
  conflicted?: string[];
  sweep_owed?: boolean;
  prior_findings: number;
  /** What the session reported: each executed pass's phase, and
   * the sweep — its claim and the status production's `sweepStatusOf` gives
   * it (an APPROVE with the sweep owed and not `ran` is what production flags
   * as `followup_sweep_skipped`). Absent until the case has an outcome. */
  executed_phases?: Array<{ agent: string; phase: "delta" | "sweep" | null }>;
  sweep?: {
    claim: "ran" | "not_owed" | "not_reached" | "skipped" | null;
    status: SweepStatus;
    note?: string;
    sweep_passes: number | null;
    skipped: boolean;
  };
}

/**
 * A follow-up case's report of what the session ran: each executed
 * pass's `phase` and the sweep — its claim and the status production's
 * `sweepStatusOf` gives it, `skipped` when an APPROVE left an owed sweep
 * un-run (production's `followup_sweep_skipped`). Pure; a full-scope case is
 * returned unchanged.
 */
export function followUpOutcomeOf(
  fu: CaseFollowUp,
  outcome: Record<string, unknown>,
  verdict: string | null,
): CaseFollowUp {
  if (fu.scope !== "delta") return fu;
  const passes = Array.isArray(outcome["passes"])
    ? (outcome["passes"] as Array<Record<string, unknown>>)
    : null;
  const phaseOf = (p: Record<string, unknown>): "delta" | "sweep" | null =>
    p["phase"] === "delta" || p["phase"] === "sweep" ? p["phase"] : null;
  const rawClaim = outcome["sweep"];
  const claim =
    rawClaim === "ran" ||
    rawClaim === "not_owed" ||
    rawClaim === "not_reached" ||
    rawClaim === "skipped"
      ? rawClaim
      : null;
  const sweepPasses = passes ? passes.filter((p) => phaseOf(p) === "sweep").length : null;
  const owed = fu.sweep_owed === true;
  const { status, note } = sweepStatusOf({
    owed,
    claim,
    sweepPasses,
    receiptSettled: false,
    verdict,
  });
  return {
    ...fu,
    ...(passes
      ? {
          executed_phases: passes.map((p) => ({
            agent: `${String(p["name"])}--${String(p["tier"])}`,
            phase: phaseOf(p),
          })),
        }
      : {}),
    sweep: {
      claim,
      status,
      ...(note ? { note } : {}),
      sweep_passes: sweepPasses,
      skipped: verdict === "APPROVE" && owed && status !== "ran" && status !== "skipped",
    },
  };
}

/**
 * The order of a follow-up replay case: production's round k, built
 * from the same pieces dispatch uses — the full plan, `decideBenchFollowUp`
 * (dispatch's `planFollowUp`), the delta patch and order delta, the prior
 * findings note, the sweep's task files — rendered from the template
 * `templateFileForOrder` picks. Any doubt runs a full re-review.
 */
function renderFollowUpPrompts(args: Parameters<typeof renderCasePrompts>[0]): CasePrompts {
  const { root, cfg, c, meta, tree } = args;
  const fu = c.followup!;
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
  const heuristics = loadProfileHeuristics(root, cfg.review.profile);
  const styleGuide = lensEnabled(cfg.lenses, "pass-style", cfg.review.style_lens)
    ? findStyleGuide(tree)
    : [];
  const ciLinters = lensEnabled(cfg.lenses, "pass-lint-conformance", cfg.review.lint_conformance)
    ? findCiLinters(tree)
    : [];
  // The whole PR's plan, exactly as dispatch builds it before deciding.
  const fullPlan = buildPassPlan(
    cfg,
    args.files,
    { title, body: body ?? undefined },
    args.ecosystem,
    heuristics,
    styleGuide,
    ciLinters,
  );
  const decided = decideBenchFollowUp(cfg, heuristics, c, {
    delta: args.followUpDelta,
    files: args.files,
    fullPlan,
    ecosystem: args.ecosystem,
    styleGuide,
    ciLinters,
  });
  const extraFiles: Array<{ path: string; text: string }> = [];
  // The ledger the PR session held when the round was dispatched: carried as
  // production's `ledger_carry` (and its SETTLED digest), and pinned as the
  // case's ledger file (QCR_LEDGER_FILE) by the caller.
  const ledgerPath = join(args.caseDir, "ledger.md");
  const ledgerCarry =
    fu.ledger !== undefined ? parseLedgerCarry(fu.ledger, c.pr, ledgerPath) : undefined;
  const settledDigest =
    ledgerCarry && fu.ledger !== undefined ? settledFromLedger(fu.ledger.trim()) : "";
  if (fu.ledger !== undefined) extraFiles.push({ path: ledgerPath, text: fu.ledger });
  let followUpArg: Parameters<typeof buildRoundOrder>[0]["followUp"];
  let report: CaseFollowUp;
  if (decided.kind === "delta") {
    const d = decided.decision;
    const patchPath = join(args.caseDir, "delta.patch");
    extraFiles.push({ path: patchPath, text: renderDeltaPatch(d.delta.files) });
    const prior = benchPriorFindings(c, join(args.caseDir, "prior.json"));
    extraFiles.push({ path: join(args.caseDir, "prior.json"), text: prior.sidecar });
    followUpArg = {
      delta: roundDeltaOf(d, patchPath),
      deltaFiles: d.deltaFiles,
      priorFindingsNote: prior.note,
      priorFindings: prior.list,
      ...(d.optionalPlan ? { optionalPlan: d.optionalPlan } : {}),
      ...(d.sweepPlan ? { sweepPlan: d.sweepPlan } : {}),
      ...(d.sweepUnswept ? { sweepUnswept: d.sweepUnswept } : {}),
    };
    report = {
      round_no: fu.round_no,
      review_no: fu.review_no,
      scope: "delta",
      delta_lines: d.delta.lines,
      delta_files: d.delta.files.length,
      ...(d.delta.conflicted.length ? { conflicted: d.delta.conflicted } : {}),
      sweep_owed: d.sweepPlan !== undefined,
      prior_findings: prior.list.findings.length,
    };
  } else {
    report = {
      round_no: fu.round_no,
      review_no: fu.review_no,
      scope: "full",
      reason: decided.reason,
      ...(decided.detail ? { detail: decided.detail } : {}),
      prior_findings: fu.prior_findings.length,
    };
  }
  const built = buildRoundOrder({
    cfg,
    row,
    files: args.files,
    roundId: 1,
    roundNo: fu.round_no,
    reviewNo: fu.review_no,
    roundType: "re-review",
    worktree: tree,
    settledDigest,
    ...(ledgerCarry ? { ledgerCarry } : {}),
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
    heuristics,
    ...(args.dependencyNote ? { dependencyNote: args.dependencyNote } : {}),
    ...(styleGuide.length ? { styleGuide } : {}),
    ...(ciLinters.length ? { ciLinters } : {}),
    plan: decided.kind === "delta" ? decided.decision.plan : fullPlan,
    ...(followUpArg ? { followUp: followUpArg } : {}),
  });
  const packed = benchContextPack(
    cfg,
    built,
    args.files,
    tree,
    args.caseDir,
    decided.kind === "delta" ? renderDeltaPatch(decided.decision.delta.files) : undefined,
  );
  const taskFiles = cfg.review.task_files
    ? renderPassTasks(packed.order, renderGateNotes(built, args.ecosystem)).map((t) => ({
        ...t,
        path: join(args.caseDir, "tasks", t.file),
      }))
    : [];
  // The sweep's own task files, from the same order dispatch renders them
  // from (`sweepOrderOf`), in their own directory.
  const sweepTasks =
    cfg.review.task_files && built.sweep_plan && built.sweep_plan.length > 0
      ? (() => {
          const sweepOrder = sweepOrderOf(packed.order, built.sweep_plan);
          return renderPassTasks(sweepOrder, renderGateNotes(sweepOrder, args.ecosystem)).map(
            (t) => ({ ...t, path: join(args.caseDir, "tasks-sweep", t.file) }),
          );
        })()
      : [];
  // The optional rows' task files, from the same order dispatch
  // renders them from (`optionalOrderOf`), in their own directory.
  const optionalTasks =
    cfg.review.task_files && built.optional_plan && built.optional_plan.length > 0
      ? (() => {
          const optionalOrder = optionalOrderOf(packed.order, built.optional_plan);
          return renderPassTasks(optionalOrder, renderGateNotes(optionalOrder, args.ecosystem)).map(
            (t) => ({ ...t, path: join(args.caseDir, "tasks-optional", t.file) }),
          );
        })()
      : [];
  const { render_outputs: _renderedByBench, ...unrendered } = built;
  const order = {
    ...unrendered,
    ...(taskFiles.length
      ? { pass_task_files: taskFiles.map((t) => ({ row: t.row, agent: t.agent, path: t.path })) }
      : {}),
    ...(sweepTasks.length
      ? { sweep_task_files: sweepTasks.map((t) => ({ row: t.row, agent: t.agent, path: t.path })) }
      : {}),
    ...(optionalTasks.length
      ? {
          optional_task_files: optionalTasks.map((t) => ({
            row: t.row,
            agent: t.agent,
            path: t.path,
          })),
        }
      : {}),
  };
  const template = readFileSync(join(root, "prompts", templateFileForOrder(order)), "utf8");
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
      roundNo: fu.round_no,
      privateReplay: true,
      prevHead: fu.prev_head,
    });
  const system = renderConversationSystemPrompt(
    readFileSync(join(root, "prompts", "conversation-system.md"), "utf8"),
    { pr: c.pr, title, worktree: tree },
    identity,
  );
  for (const t of sweepTasks) extraFiles.push({ path: t.path, text: t.text });
  for (const t of optionalTasks) extraFiles.push({ path: t.path, text: t.text });
  return {
    system,
    order: orderText,
    plannedLenses: order.pass_plan.map((p) => p.agent),
    passPlan: order.pass_plan,
    taskFiles: taskFiles.map((t) => ({ path: t.path, text: t.text })),
    ...(packed.file ? { contextPack: packed.file } : {}),
    extraFiles,
    followUp: report,
    ...(built.sweep_plan && built.sweep_plan.length > 0 ? { sweepPlan: built.sweep_plan } : {}),
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

/** Why a session's JSON output file cannot be used: `undefined` when it parses,
 * `"missing"` when absent, otherwise the parser's message. */
export function jsonProblem(path: string): string | undefined {
  if (!existsSync(path)) return "missing";
  try {
    JSON.parse(readFileSync(path, "utf8"));
    return undefined;
  } catch (err) {
    return String(err instanceof Error ? err.message : err).slice(0, 300);
  }
}

/** The BENCHMARK MODE files the session wrote that do not parse — the ones a
 * scorer reads as JSON (the outcome always; the findings record when the bench
 * renders the posted review from it). A missing file is not listed here. */
export function unparseableOutputs(caseDir: string, renderOutputs: boolean): string[] {
  const names = renderOutputs ? [CASE_FILES.findings, CASE_FILES.outcome] : [CASE_FILES.outcome];
  const out: string[] = [];
  for (const n of names) {
    const p = jsonProblem(join(caseDir, n));
    if (p !== undefined && p !== "missing") out.push(`${n} is not valid JSON (${p})`);
  }
  return out;
}

/** The session's event stream and stderr in a case dir. */
const PI_RUN_FILES = ["pi-events.jsonl", "pi-stderr.log"] as const;

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
  for (const f of [...Object.values(CASE_FILES), ...POLICED_ORIGINALS, HEAD_PATCHES_FILE])
    rmSync(join(caseDir, f), { force: true });
  // Before anything can fail: the cost reader prices the events file
  // (src/bench/cost.ts) whatever this attempt's outcome.
  for (const f of PI_RUN_FILES) rmSync(join(caseDir, f), { force: true });
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
    // The head-side patches, kept per case so a results rebuild re-anchors
    // LEFT comments exactly as this run does (collectComments).
    const headPatches: Record<string, string> = {};
    for (const f of files) if (f.patch !== undefined) headPatches[f.filename] = f.patch;
    writeFileSync(join(caseDir, HEAD_PATCHES_FILE), JSON.stringify(headPatches) + "\n");
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
    // A follow-up case: the PR-owned delta, by production's own
    // `prOwnedDelta` over this tree. Total: a throw is a full round.
    let followUpDelta: PrOwnedDelta | undefined;
    if (c.followup) {
      try {
        followUpDelta = await benchDelta(tree, c, meta);
      } catch (err) {
        followUpDelta = {
          ok: false,
          reason: "diff-failed",
          detail: String(err instanceof Error ? err.message : err).slice(0, 200),
        };
      }
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
      ...(followUpDelta ? { followUpDelta } : {}),
    });
    summary.planned_lenses = prompts.plannedLenses;
    writeFileSync(join(caseDir, "pass-plan.json"), JSON.stringify(prompts.passPlan, null, 2));
    if (c.followup) {
      // An earlier attempt's ledger, patch or sweep tasks never leak into this one.
      for (const f of ["ledger.md", "delta.patch", "prior.json", "sweep-plan.json"])
        rmSync(join(caseDir, f), { force: true });
      rmSync(join(caseDir, "tasks-sweep"), { recursive: true, force: true });
      rmSync(join(caseDir, "tasks-optional"), { recursive: true, force: true });
      for (const f of prompts.extraFiles ?? []) {
        mkdirSync(dirname(f.path), { recursive: true });
        writeFileSync(f.path, f.text);
      }
      if (prompts.sweepPlan)
        writeFileSync(join(caseDir, "sweep-plan.json"), JSON.stringify(prompts.sweepPlan, null, 2));
      if (prompts.followUp) {
        summary.follow_up = prompts.followUp;
        log(
          `review: ${c.instance_id} — follow-up round ${prompts.followUp.round_no}: ${prompts.followUp.scope}${prompts.followUp.reason ? ` (${prompts.followUp.reason})` : ""}${prompts.followUp.sweep_owed ? ", sweep owed" : ""}`,
        );
      }
    }
    // An earlier attempt's task files never leak into this one: launch_plan
    // launches every task file the dir holds.
    rmSync(join(caseDir, "tasks"), { recursive: true, force: true });
    rmSync(join(caseDir, CONTEXT_PACK_FILE), { force: true });
    if (prompts.contextPack) writeFileSync(prompts.contextPack.path, prompts.contextPack.text);
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
      QCR_SUBAGENT_CACHE_GROUP: String(ctx.cfg.pi.subagent_cache_group ?? 0),
      QCR_SUBAGENT_CACHE_STAGGER_MS: String(ctx.cfg.pi.subagent_cache_stagger_ms ?? 2500),
      QCR_LEAF_CACHE_EXT: join(o.root, "extensions", "leaf-cache.ts"),
      // The case's task dirs are this replay's sanctioned launch_plan
      // dirs (production's live under state/pr-<n>-round-<k>-passes/).
      QCR_LAUNCH_PLAN_DIRS: [
        join(caseDir, "tasks"),
        join(caseDir, "tasks-optional"),
        join(caseDir, "tasks-sweep"),
      ].join(delimiter),
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
    const events = join(caseDir, PI_RUN_FILES[0]);
    const stderr = join(caseDir, PI_RUN_FILES[1]);
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
    // stopped short is redelivery, not a fresh review. Same session —
    // and only if there IS one: pi persists a session after its first
    // assistant message, and `--continue` on an empty session dir silently
    // starts a NEW session that would review with no round order at all.
    // A round whose files are there but do not parse stopped short too (a
    // model that broke its own JSON escaping): the same one continuation,
    // told which file and what the parser said.
    const broken = existsSync(outcomePath)
      ? unparseableOutputs(caseDir, ctx.cfg.review.render_outputs)
      : [];
    const resumable =
      existsSync(sessionDir) && readdirSync(sessionDir).some((f) => f.endsWith(".jsonl"));
    if (!r.timedOut && !r.streamError && !existsSync(outcomePath) && !resumable) {
      summary.error = `pi exited ${String(r.code)} before any assistant message — nothing to continue`;
    }
    const stoppedShort = !existsSync(outcomePath) || broken.length > 0;
    if (!r.timedOut && !r.streamError && stoppedShort && resumable) {
      const left = o.timeoutMs - (Date.now() - started);
      if (left > 120_000) {
        summary.continued = true;
        log(
          broken.length
            ? `review: ${c.instance_id} — ${broken.join("; ")}, one continuation`
            : `review: ${c.instance_id} — no outcome.json yet, one continuation`,
        );
        r = await runPi(
          [
            ...base,
            "--continue",
            "-p",
            broken.length
              ? `Your BENCHMARK MODE files in ${caseDir} cannot be read: ${broken.join("; ")}. Rewrite ${broken.length > 1 ? "them" : "it"} as valid JSON with the same content — plain double quotes, no escaped quotes around keys or values — and write ${CASE_FILES.outcome} last.`
              : ctx.cfg.review.render_outputs
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
      // Per-stage cost and time (stages.json; the per-phase totals
      // ride the summary).
      const stages = stagesFromEvents(lines);
      writeFileSync(join(caseDir, "stages.json"), JSON.stringify(stages, null, 2) + "\n");
      summary.stages = stages.phases;
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
    comments = collected.comments;
    summary.comments.reanchored = collected.reanchored;
    summary.comments.unparseable = collected.dropped;
    summary.comments.body = collected.body;
    summary.verdict = typeof outcome?.["verdict"] === "string" ? outcome["verdict"] : null;
    summary.executed_passes = Array.isArray(outcome?.["passes"])
      ? (outcome["passes"] as Array<Record<string, unknown>>).map(
          (p) => `${String(p["name"])}--${String(p["tier"])}`,
        )
      : [];
    // A follow-up case keeps the session's own phase and sweep
    // report, read the way production's verdict tail reads it.
    if (summary.follow_up && outcome !== undefined)
      summary.follow_up = followUpOutcomeOf(summary.follow_up, outcome, summary.verdict);
    summary.status = r.timedOut
      ? "timeout"
      : outcome === undefined || rawComments === undefined
        ? "no-output"
        : summary.verdict === "APPROVE" || summary.verdict === "REQUEST_CHANGES"
          ? "ok"
          : "no-verdict";
    // A no-output round says why when the files are there but unreadable.
    if (summary.status === "no-output" && summary.error === undefined) {
      const still = unparseableOutputs(caseDir, ctx.cfg.review.render_outputs);
      if (still.length) summary.error = still.join("; ").slice(0, 2000);
    }
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

/** The case file holding the run's head-side patches by path. */
export const HEAD_PATCHES_FILE = "head-patches.json";

/** Everything this case POSTED, as scored comments: the inline comments the
 * session wrote, plus the findings its record marks posted that went into the
 * review body for want of an inline anchor. A comment the session anchored on
 * a DELETED line is moved to the head side of its hunk, from the patches the
 * run kept: every scorer the bench feeds reads head-side lines only, and the
 * comment was otherwise dropped whole (reanchorLeftComments). A case dir
 * without that file leaves LEFT comments where they are. The one reader of a
 * case dir's output, shared by a live run and `cli results` so a rebuild
 * scores the same. */
export function collectComments(caseDir: string): {
  comments: BenchComment[];
  dropped: number;
  body: number;
  reanchored: number;
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
  const rawPatches = readJson(join(caseDir, HEAD_PATCHES_FILE));
  const patches: Record<string, string> = {};
  if (typeof rawPatches === "object" && rawPatches !== null && !Array.isArray(rawPatches))
    for (const [path, patch] of Object.entries(rawPatches))
      if (typeof patch === "string") patches[path] = patch;
  const moved = reanchorLeftComments(
    [...parsed.comments.map((c) => ({ ...c, source: "inline" as const })), ...inBody],
    patches,
  );
  return {
    comments: moved.comments,
    dropped: parsed.dropped,
    body: inBody.length,
    reanchored: moved.reanchored,
  };
}

/** The case summary and every variant's result file of one case. */
function caseFiles(outDir: string, c: BenchCase): [string, ...string[]] {
  return [
    join(outDir, "cases", safeId(c.instance_id), "case-summary.json"),
    ...Object.keys(VARIANTS).map((v) =>
      join(outDir, "results", v, `${safeId(c.instance_id)}.json`),
    ),
  ];
}

/** Every case whose summary records another fingerprint (or none, or cannot
 * be read) loses its summary and every variant's result file. A case with no
 * summary is left as it is: nothing claims it for any configuration. Returns
 * the dropped instance ids. */
export function dropForeignCases(
  outDir: string,
  cases: readonly BenchCase[],
  fingerprint: RunFingerprint,
  log: (line: string) => void,
): string[] {
  const dropped: string[] = [];
  for (const c of cases) {
    const files = caseFiles(outDir, c);
    if (!existsSync(files[0])) continue;
    let prior: CaseSummary | null = null;
    try {
      prior = JSON.parse(readFileSync(files[0], "utf8")) as CaseSummary;
    } catch {
      // an unreadable summary is no proof of this run's fingerprint
    }
    if (JSON.stringify(prior?.fingerprint ?? null) === JSON.stringify(fingerprint)) continue;
    log(
      `review: ${c.instance_id} was reviewed by a different build/profile — its result is dropped`,
    );
    for (const f of files) rmSync(f, { force: true });
    dropped.push(c.instance_id);
  }
  return dropped;
}

/** The review command's case set-up before run.json is written: a fresh run
 * clears every case it owns; a resumed run keeps the cases this fingerprint
 * produced and drops the rest (dropForeignCases), so a run stopped partway
 * (AuthExpiring) leaves those cases missing rather than scored under the new
 * configuration's label. The fingerprint is the one the case containers
 * compute: bench.sh gives the init phase the same QCR_BENCH_AUTH. Returns the
 * dropped instance ids of a resume. */
export function prepareReviewCases(
  outDir: string,
  cases: readonly BenchCase[],
  opts: { resume: boolean; fingerprint: RunFingerprint },
  log: (line: string) => void,
): string[] {
  if (opts.resume) return dropForeignCases(outDir, cases, opts.fingerprint, log);
  for (const c of cases) for (const f of caseFiles(outDir, c)) rmSync(f, { force: true });
  return [];
}

/** The record of a case that was never prefetched: a failed summary carrying
 * the run's fingerprint (a resume under the same configuration keeps it) and
 * an EMPTY result file per variant — the scorer silently drops an instance
 * with no file from both denominators, so a skipped case would shrink the
 * benchmark instead of costing its references. */
export function recordUnprefetched(
  outDir: string,
  c: BenchCase,
  error: string,
  fingerprint: RunFingerprint,
): CaseSummary {
  const s: CaseSummary = {
    instance_id: c.instance_id,
    status: "failed",
    error,
    fingerprint,
    verdict: null,
    duration_seconds: 0,
    usage: { input: 0, output: 0, cacheRead: 0, children: 0 },
    planned_lenses: [],
    executed_passes: [],
    comments: { total: 0, by_tag: {}, left_side: 0, unparseable: 0, body: 0 },
    pr_meta: { title: false, body: false, base_ref_source: "none" },
    diff: { files: 0, additions: 0, deletions: 0 },
    continued: false,
    warnings: [],
  };
  mkdirSync(join(outDir, "cases", safeId(c.instance_id)), { recursive: true });
  // No session ran: an earlier attempt's event stream is not this one's cost.
  for (const f of PI_RUN_FILES)
    rmSync(join(outDir, "cases", safeId(c.instance_id), f), { force: true });
  writeFileSync(
    join(outDir, "cases", safeId(c.instance_id), "case-summary.json"),
    JSON.stringify(s, null, 2) + "\n",
  );
  writeResults(outDir, c, [], s);
  return s;
}

/** Write the scorer's input for every variant; returns the variants whose
 * file for this case now holds different bytes than before. */
export function writeResults(
  outDir: string,
  c: BenchCase,
  comments: readonly BenchComment[],
  summary: CaseSummary,
): Variant[] {
  const changed: Variant[] = [];
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
    const file = join(dir, `${safeId(c.instance_id)}.json`);
    const text = JSON.stringify(result, null, 2) + "\n";
    let before: string | null = null;
    try {
      before = readFileSync(file, "utf8");
    } catch {
      // no earlier result for this case
    }
    if (before !== text) changed.push(variant);
    writeFileSync(file, text);
  }
  return changed;
}

/** `cli results`: rebuild every finished case's summary counts and scorer
 * inputs from its case dir. The harness scored the result files as they
 * were, so a variant whose file for any case changed has every metrics file
 * beside it removed (as the eval step's own `rm -f metrics_*.json` does): a
 * report before the next eval shows no score rather than a stale one. A
 * variant whose files all came out byte-identical keeps its metrics. */
export function rebuildResults(
  outDir: string,
  cases: readonly BenchCase[],
  log: (line: string) => void,
): void {
  const changed = new Set<Variant>();
  for (const c of cases) {
    const dir = join(outDir, "cases", safeId(c.instance_id));
    const sPath = join(dir, "case-summary.json");
    if (!existsSync(sPath)) continue;
    const s = JSON.parse(readFileSync(sPath, "utf8")) as CaseSummary;
    const collected = collectComments(dir);
    // Refresh the per-case counts too, so the report describes exactly
    // what the rebuilt result files score.
    s.comments = {
      total: collected.comments.length,
      by_tag: {},
      left_side: collected.comments.filter((x) => x.side === "LEFT").length,
      unparseable: collected.dropped,
      body: collected.body,
      reanchored: collected.reanchored,
    };
    for (const x of collected.comments)
      s.comments.by_tag[x.tag] = (s.comments.by_tag[x.tag] ?? 0) + 1;
    writeFileSync(sPath, JSON.stringify(s, null, 2) + "\n");
    for (const v of writeResults(outDir, c, collected.comments, s)) changed.add(v);
  }
  for (const variant of changed) {
    const dir = join(outDir, "results", variant);
    const stale = readdirSync(dir).filter((n) => n.startsWith("metrics_") && n.endsWith(".json"));
    for (const f of stale) rmSync(join(dir, f), { force: true });
    if (stale.length)
      log(
        `results: ${variant}: ${stale.length} metrics file(s) scored the old results — removed; re-run eval to score the rebuilt ones`,
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
  // The profile's lens tuning (and its `[posting]` policy) is
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
  for (const pass of Object.keys(m.pass_models))
    m.pass_models[pass] = modelForAuth(m.pass_models[pass]!, mode);
  return out;
}
