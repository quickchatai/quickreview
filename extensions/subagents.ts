// subagents — first-party glue over pi's OWN subagent extension.
//
// The third-party amosblomqvist/pi-subagents extension is REMOVED (owner,
// 2026-08-30: unlicensed upstream, stale, and pi now ships a first-party
// equivalent inside the pinned npm package). This file is the ONE loader for
// that native extension, on both surfaces (VM sessions via
// `src/sessions.ts` extensionPaths, companion via `src/tui/companion.ts`
// piArgv), and it exists for three reasons the native code does not cover:
//
//  1. **Sourcing without drift.** The native extension is imported AT RUNTIME
//     from the installed pi package
//     (`<getExamplesPath()>/extensions/subagent/index.ts` — `examples/` ships
//     in the published tarball, verified against 0.84.4 and re-verified at
//     0.87.1, 0.99.1 and 1.0.0 (examples/extensions/subagent byte-identical), package.json
//     `files`). There is no vendored copy, so there is nothing that can drift
//     from the rule-7 pin: bumping pi bumps the extension with it.
//
//  2. **The leaves invariant needs a process-wide cap and a scope pin.** The
//     native tool caps concurrency only WITHIN one `tasks:[…]` call
//     (MAX_CONCURRENCY = 4, index.ts) — multiple single-mode `subagent` calls
//     in one assistant turn (the fan-out pattern the round templates mandate)
//     run with NO cap at all, because pi dispatches a turn's tool calls via
//     Promise.all. The weighted semaphore below restores the process-wide cap
//     the old extension had (default 4; the VM passes 6 via
//     QCR_SUBAGENT_MAX_CONCURRENCY, from config.toml [pi]
//     subagent_max_concurrency).
//
//  3. **Child processes must never see repo-controlled pi config.** Native
//     children spawn as `pi --mode json -p --no-session` WITHOUT
//     `--no-extensions` (the old extension passed it), so a child's cwd
//     decides which PROJECT `.pi/` resources it loads — and
//     `defaultProjectTrust = "always"` (the no-stall decision) trusts them
//     all. A task `cwd` pointing into a reviewed-repo worktree would load
//     that repo's `.pi/extensions` into a reviewer child. The sanitizer
//     therefore STRIPS every `cwd` param (top-level, tasks[], chain[]): a
//     child always runs in the parent session's own cwd (the sandbox root /
//     /workspace — first-party ground), and passes address the worktree by
//     absolute path exactly as their task strings already do. It also pins
//     `agentScope` (default "user": agents come from ~/.pi/agent/agents,
//     which both entrypoints symlink to the sanctioned agent dir — built
//     state/agents on the VM, docker/companion/agents in the companion) and
//     forces `confirmProjectAgents: false` (never an interactive modal).
//
// Beside the wrapped subagent tool the glue registers `launch_plan` (,
// below): the round's discovery task files launched as ONE call through the
// same wrapped execute, so the one-turn launch the round templates ask for is
// one tool call rather than a discipline.
//
// What stays structural without any glue: children never gain the `subagent`
// tool (this extension rides per-spawn argv, never the global settings.json,
// and children load only global extensions), so a pass cannot fan out — the
// single-shepherd leaves rule (root CLAUDE.md rule 9). Children DO now load
// the globally-registered bash-guard, which is a strengthening: the old
// `--no-extensions` children had only the prompt-level exec policy.
//
// VERIFY-ON-PIN (0.84.4, read statically from the published tarball, and
// the subagent example re-compared byte-identical at 0.87.1, 0.99.1 and 1.0.0; live
// smoke listed in the report):
//  - native child argv is `--mode json -p --no-session` + optional
//    --model/--thinking/--tools/--append-system-prompt (examples/extensions/
//    subagent/index.ts, runSingleAgent) — `-p`/`--no-session`/`--mode json`
//    all read as a LEAF by the vendored OpenViking fork's qcr-leaf.ts;
//  - `--tools` names missing from the child's registry are IGNORED, never a
//    startup error (dist/core/agent-session.js _refreshToolRegistry);
//  - `--model provider/id:<thinking>` shorthand sets the thinking level
//    (dist/main.js "Allow --model <pattern>:<thinking>"), which is how the
//    built agents' per-tier thinking survives the native extension reading
//    only the `model:` frontmatter field;
//  - a jiti-loaded extension can dynamic-import the package root and a .ts
//    file inside the installed package. If either import fails the tool is
//    simply never registered and the round templates' "Unknown agent = STOP"
//    rule holds — logged FATAL below, never a crashed pi.
import type { Pi, PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { readdirSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

/** Env var pinning the discovery scope. "user" (default) reads ONLY
 * ~/.pi/agent/agents — repo-controlled `.pi/agents` dirs are unreachable no
 * matter what the model asks for. */
export const SCOPE_ENV = "QCR_SUBAGENT_SCOPE";

/** Env var carrying the process-wide child cap (VM: 6, from config.toml
 * [pi] subagent_max_concurrency riding the session command line). */
export const CONCURRENCY_ENV = "QCR_SUBAGENT_MAX_CONCURRENCY";

/** Env var switching the WIDE fan-out on ("1"): a `tasks:[…]` call is split
 * into native-sized chunks that run CONCURRENTLY, each under its own permits
 * of the process-wide semaphore, so one batched launch runs as wide as the
 * configured cap instead of native's in-call four (bench/aacr/PERF.md §1).
 * Absent or anything but "1" ⇒ the native shape (the companion's default).
 * The VM session and the bench set it from `[review] wide_lens_fanout`. */
export const WIDE_FANOUT_ENV = "QCR_SUBAGENT_WIDE_FANOUT";

/** Whether the wide fan-out is on for this process. */
export function resolveWideFanout(env: Record<string, string | undefined> = process.env): boolean {
  return (env[WIDE_FANOUT_ENV] ?? "").trim() === "1";
}

/** Default process-wide cap — the companion's desktop number; the old
 * extension's config.json default was the same 4. */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** The native extension's own within-one-call concurrency constant
 * (examples/extensions/subagent/index.ts MAX_CONCURRENCY). A parallel call
 * never runs more than this many children at once regardless of our permits,
 * so it is also the honest weight ceiling for one call. */
export const NATIVE_IN_CALL_CONCURRENCY = 4;

/** Native rejects a tasks array above this size before starting any child.
 * VERIFY-ON-PIN (pi 0.84.4 examples/extensions/subagent/index.ts,
 * MAX_PARALLEL_TASKS). The wrapper chunks at this boundary so selecting nine
 * or ten legitimate lenses cannot become a deterministic zero-pass round. */
export const NATIVE_MAX_PARALLEL_TASKS = 8;

const VALID_SCOPES = new Set(["user", "project", "both"]);

/** Resolve the pinned scope from the environment (invalid/absent → "user"). */
export function resolveScope(env: Record<string, string | undefined> = process.env): string {
  const raw = (env[SCOPE_ENV] ?? "").trim();
  return VALID_SCOPES.has(raw) ? raw : "user";
}

/** Resolve the process-wide cap from the environment (invalid/absent → 4).
 * Strict digits only — "1e3" or "6x" is a misconfiguration, and a
 * misconfiguration falls back to the safe default rather than whatever
 * parseInt salvages from the prefix. */
export function resolveMaxConcurrency(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = (env[CONCURRENCY_ENV] ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 64 ? n : DEFAULT_MAX_CONCURRENCY;
}

/** Drop `cwd` from a task/chain item, leaving the rest untouched. */
function stripCwd(item: unknown): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const { cwd: _cwd, ...rest } = item as Record<string, unknown>;
  return rest;
}

/**
 * Pin scope + trust behaviour and strip every `cwd` before the native tool
 * sees the params. Reason 3 in the header: a child must never run inside a
 * reviewed-repo worktree, where always-on project trust would load that
 * repo's `.pi/` resources into a reviewer process.
 */
export function sanitizeParams(
  params: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...params,
    agentScope: resolveScope(env),
    confirmProjectAgents: false,
  };
  delete out.cwd;
  if (Array.isArray(out.tasks)) out.tasks = out.tasks.map(stripCwd);
  if (Array.isArray(out.chain)) out.chain = out.chain.map(stripCwd);
  return out;
}

/**
 * Semaphore weight of one call: how many children it can have in flight at
 * once. Single and chain calls run one child at a time; a parallel call runs
 * up to min(tasks, native's own in-call cap). Clamped to `permits` so one
 * oversized call can always start (it self-limits inside).
 */
export function callWeight(params: Record<string, unknown>, permits: number): number {
  const tasks = Array.isArray(params.tasks) ? params.tasks.length : 0;
  if (tasks > 1) return Math.max(1, Math.min(tasks, NATIVE_IN_CALL_CONCURRENCY, permits));
  return 1;
}

/** A weighted counting semaphore (FIFO). */
export class WeightedSemaphore {
  private available: number;
  private readonly waiters: Array<{ weight: number; resolve: () => void }> = [];

  constructor(readonly permits: number) {
    this.available = permits;
  }

  /** Number of permits currently held (for tests/diagnostics). */
  get held(): number {
    return this.permits - this.available;
  }

  async acquire(weight: number): Promise<void> {
    const w = Math.max(1, Math.min(weight, this.permits));
    if (this.available >= w && this.waiters.length === 0) {
      this.available -= w;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ weight: w, resolve });
    });
  }

  release(weight: number): void {
    this.available += Math.max(1, Math.min(weight, this.permits));
    if (this.available > this.permits) this.available = this.permits;
    while (
      this.waiters.length > 0 &&
      this.waiters[0] !== undefined &&
      this.available >= this.waiters[0].weight
    ) {
      const next = this.waiters.shift();
      if (!next) break;
      this.available -= next.weight;
      next.resolve();
    }
  }
}

type ToolExecute = PiToolDefinition["execute"];

interface ParallelNativeResult {
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  details: { mode?: string; results: unknown[]; [key: string]: unknown };
  isError?: boolean;
  [key: string]: unknown;
}

function parallelResult(value: unknown): ParallelNativeResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("subagents: native parallel result contract changed (result is not an object)");
  }
  const result = value as Partial<ParallelNativeResult>;
  if (
    !Array.isArray(result.content) ||
    typeof result.details !== "object" ||
    result.details === null ||
    !Array.isArray(result.details.results)
  ) {
    throw new Error(
      "subagents: native parallel result contract changed (content/details.results missing)",
    );
  }
  return result as ParallelNativeResult;
}

function failedParallelChild(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return true;
  const child = value as { exitCode?: unknown; stopReason?: unknown };
  return child.exitCode !== 0 || child.stopReason === "error" || child.stopReason === "aborted";
}

function renderedParallelContent(results: unknown[], chunks: string[]): string {
  const successCount = results.filter((result) => !failedParallelChild(result)).length;
  const bodies = chunks.map((text) => text.replace(/^Parallel: \d+\/\d+ succeeded\n\n/, ""));
  return `Parallel: ${successCount}/${results.length} succeeded\n\n${bodies.join("\n\n---\n\n")}`;
}

/** Wrap the native tool's execute with the sanitizer + the semaphore. */
export function wrapExecute(
  execute: ToolExecute,
  semaphore: WeightedSemaphore,
  env: Record<string, string | undefined> = process.env,
): ToolExecute {
  return async function wrapped(this: unknown, id, params, signal, onUpdate, ctx) {
    const safe = sanitizeParams(params ?? {}, env);
    if (resolveWideFanout(env) && Array.isArray(safe.tasks) && safe.tasks.length > 1) {
      return await runWide.call(this, execute, semaphore, id, safe, signal, onUpdate, ctx);
    }
    const weight = callWeight(safe, semaphore.permits);
    await semaphore.acquire(weight);
    try {
      // A call may have been aborted while parked behind another invocation.
      // Never spend its newly-acquired permit on native children.
      signal?.throwIfAborted();
      const tasks = Array.isArray(safe.tasks) ? safe.tasks : [];
      // Native can run four children inside one call. A configured process cap
      // below four therefore also bounds the array size; otherwise native
      // would exceed the cap before our outer semaphore could intervene.
      const chunkSize =
        semaphore.permits < NATIVE_IN_CALL_CONCURRENCY
          ? semaphore.permits
          : NATIVE_MAX_PARALLEL_TASKS;
      if (tasks.length <= chunkSize) {
        return await execute.call(this, id, safe, signal, onUpdate, ctx);
      }

      // Pi rejects >8 tasks before starting a child. Keep one logical tool
      // call and one semaphore lease, but feed native stable contiguous
      // chunks sequentially. Sequential chunks preserve the process-wide cap:
      // two native calls from one model call can never overlap behind the one
      // weight reservation.
      const allResults: unknown[] = [];
      const rendered: string[] = [];
      let last: ParallelNativeResult | undefined;
      let anyError = false;
      for (let offset = 0; offset < tasks.length; offset += chunkSize) {
        signal?.throwIfAborted();
        const chunk = tasks.slice(offset, offset + chunkSize);
        const notify =
          typeof onUpdate === "function"
            ? (onUpdate as unknown as (update: ParallelNativeResult) => void)
            : undefined;
        const chunkUpdate = notify
          ? (update: unknown) => {
              // Progress is advisory. Drop a malformed native update and let
              // the final result produce the explicit pin-compatibility error.
              let value: ParallelNativeResult;
              try {
                value = parallelResult(update);
              } catch {
                return;
              }
              notify({
                ...value,
                details: {
                  ...value.details,
                  mode: "parallel",
                  results: [...allResults, ...value.details.results],
                },
              });
            }
          : undefined;
        const value = parallelResult(
          await execute.call(this, id, { ...safe, tasks: chunk }, signal, chunkUpdate, ctx),
        );
        last = value;
        anyError ||= value.isError === true;
        allResults.push(...value.details.results);
        const text = value.content
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("\n");
        if (text) rendered.push(text);
      }

      return {
        ...last,
        content: [{ type: "text" as const, text: renderedParallelContent(allResults, rendered) }],
        details: { ...last?.details, mode: "parallel", results: allResults },
        ...(anyError ? { isError: true } : {}),
      };
    } finally {
      semaphore.release(weight);
    }
  };
}

/**
 * The wide fan-out: one `tasks:[…]` call, split into contiguous chunks of at
 * most native's in-call concurrency, every chunk launched at once. Each chunk
 * holds exactly as many semaphore permits as it can have children in flight,
 * so the process-wide cap still binds across every call of the process, and
 * a chunk never exceeds native's own MAX_PARALLEL_TASKS. Results keep task
 * order, and the combined result has the shape the sequential path returns.
 */
async function runWide(
  this: unknown,
  execute: ToolExecute,
  semaphore: WeightedSemaphore,
  id: Parameters<ToolExecute>[0],
  safe: Record<string, unknown>,
  signal: Parameters<ToolExecute>[2],
  onUpdate: Parameters<ToolExecute>[3],
  ctx: Parameters<ToolExecute>[4],
): Promise<Awaited<ReturnType<ToolExecute>>> {
  const tasks = safe.tasks as unknown[];
  const size = Math.max(1, Math.min(NATIVE_IN_CALL_CONCURRENCY, semaphore.permits));
  const chunks: unknown[][] = [];
  for (let offset = 0; offset < tasks.length; offset += size)
    chunks.push(tasks.slice(offset, offset + size));
  const partial: unknown[][] = chunks.map(() => []);
  const notify =
    typeof onUpdate === "function"
      ? (onUpdate as unknown as (update: ParallelNativeResult) => void)
      : undefined;
  const values = await Promise.all(
    chunks.map(async (chunk, index) => {
      await semaphore.acquire(chunk.length);
      try {
        signal?.throwIfAborted();
        const chunkUpdate = notify
          ? (update: unknown) => {
              let value: ParallelNativeResult;
              try {
                value = parallelResult(update);
              } catch {
                return;
              }
              partial[index] = value.details.results;
              notify({
                ...value,
                details: { ...value.details, mode: "parallel", results: partial.flat() },
              });
            }
          : undefined;
        const value = parallelResult(
          await execute.call(this, id, { ...safe, tasks: chunk }, signal, chunkUpdate, ctx),
        );
        partial[index] = value.details.results;
        return value;
      } finally {
        semaphore.release(chunk.length);
      }
    }),
  );
  const allResults = values.flatMap((v) => v.details.results);
  const rendered = values
    .map((v) =>
      v.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text)
        .join("\n"),
    )
    .filter((text) => text);
  const last = values[values.length - 1];
  const anyError = values.some((v) => v.isError === true);
  return {
    ...last,
    content: [{ type: "text" as const, text: renderedParallelContent(allResults, rendered) }],
    details: { ...last?.details, mode: "parallel", results: allResults },
    ...(anyError ? { isError: true } : {}),
  };
}

// ---------------------------------------------------------------------------
// launch_plan — the one-turn discovery launch, made structural.
//
// The round templates have always asked the PR's main session to launch every
// discovery row in ONE assistant turn. Live rounds show it often did not: in
// 6 of 12 studied rounds the session launched one lens per turn (fan-out
// 850–1,740 s instead of ~150–220 s) or launched pass-baseline alone and
// waited, and every round spent 20–150 s hand-writing 20-odd near-identical
// subagent calls whose whole task is a pointer to the task file the daemon
// already wrote (`[review] task_files`, src/passtasks.ts). `launch_plan`
// reads the round's task directory and launches every discovery task file in
// it as ONE `tasks:[…]` call through the SAME wrapped execute the subagent
// tool runs — the same sanitizer, the same process-wide semaphore, the same
// wide fan-out — so the result is exactly what the subagent tool returns and
// the session merges it as before.
//
// Still the main session's act (root rule 9): the session calls the tool; the
// daemon schedules nothing. Bounded on purpose:
//  - only a round's sanctioned task dirs — `<sandbox root>/state/pr-<n>-round-
//    <k>-passes/tasks` (the plan) and `…/tasks-sweep` (the owed pre-approval
//    sweep), or the pass dir itself, which means its `tasks` — every path
//    resolved through symlinks first; the bench names its case dirs exactly in
//    QCR_LAUNCH_PLAN_DIRS (the session cannot set its own environment);
//  - only regular files named as passtasks.ts names them (`NN-<agent>.md`), so
//    a symlink planted in the dir is never followed;
//  - never the validator (`pass-validate…`): it runs after discovery, over
//    the candidates, and has no task file anyway — excluded here as a belt;
//  - no cwd and no free-form agent: each unit is the row's file-named agent
//    and the pointer the templates prescribe, plus optional `extra` text the
//    session keys to a row (a prior finding to verify, a site to look at).
// Rows the session RAISES are named in `skip` and launched through the
// subagent tool in the same turn; rows it ADDS have no file and go there too.

/** The tool's name, as the round templates spell it. */
export const LAUNCH_PLAN_TOOL = "launch_plan";

/** Env var naming EXTRA sanctioned task dirs, exactly, separated by the
 * platform path delimiter — the bench's `<case>/tasks` and `<case>/tasks-sweep`
 * (src/bench/runner.ts). Production never sets it. */
export const LAUNCH_PLAN_DIRS_ENV = "QCR_LAUNCH_PLAN_DIRS";

/** A round's pass directory, as dispatch.ts names it. */
const PASSES_DIR_RE = /^pr-\d+-round-\d+-passes$/;
/** A task file, as passtasks.ts names it: the 1-based row, then the agent. */
const TASK_FILE_RE = /^(\d{2,})-([a-z0-9][a-z0-9-]*)\.md$/;
/** The validator's agent ids — `pass-validate` and its tier variants. */
const VALIDATOR_AGENT_RE = /^pass-validate(--|$)/;

/** The pointer a task-file launch carries — the exact words the round
 * templates prescribe (src/passtasks.ts renderPassTaskNote). */
export function taskPointer(path: string): string {
  return `Task file: ${path}. Read it first; it is your complete task.`;
}

/** One unit of a planned launch. */
export interface LaunchUnit {
  /** "plan" for the round's tasks dir, "sweep" for the sweep's. */
  phase: "plan" | "sweep";
  /** 1-based row, as the plan tables print it. */
  row: number;
  agent: string;
  file: string;
  path: string;
  task: string;
}

export type LaunchPlan =
  { ok: true; units: LaunchUnit[]; skipped: LaunchUnit[] } | { ok: false; error: string };

function realDir(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The extra sanctioned dirs from the environment, each resolved; one that
 * does not exist sanctions nothing. */
function sanctionedExtras(env: Record<string, string | undefined>): Set<string> {
  const out = new Set<string>();
  for (const raw of (env[LAUNCH_PLAN_DIRS_ENV] ?? "").split(delimiter)) {
    const p = raw.trim();
    if (!p || !isAbsolute(p)) continue;
    const real = realDir(p);
    if (real) out.add(real);
  }
  return out;
}

/** Resolve one `dirs` entry to a sanctioned task dir, or say why not. */
function resolveTaskDir(
  input: string,
  realRoot: string,
  extras: ReadonlySet<string>,
  pr: string | undefined,
): { dir: string; phase: "plan" | "sweep"; passes: string | undefined } | { error: string } {
  const real = realDir(resolve(realRoot, input));
  if (!real) return { error: `${input}: no such directory` };
  // Resolved too: on the VM `<sandbox>/state` is a SYMLINK to the state volume
  // (entrypoint.sh.j2), so a resolved task dir lives under its target.
  const state = realDir(join(realRoot, "state")) ?? join(realRoot, "state");
  // A PR session (QCR_PR, set by the daemon — the session cannot set its own
  // environment) launches only its own PR's rounds.
  const ownPasses = (name: string) =>
    PASSES_DIR_RE.test(name) && (pr === undefined || name.startsWith(`pr-${pr}-round-`));
  if (dirname(real) === state && ownPasses(basename(real))) {
    // The round's pass dir: its plan tasks. The sweep's dir is named itself.
    const tasks = realDir(join(real, "tasks"));
    if (!tasks || tasks !== join(real, "tasks"))
      return { error: `${input}: the round has no task files (no tasks/ directory)` };
    return { dir: tasks, phase: "plan", passes: real };
  }
  const name = basename(real);
  if (
    (name === "tasks" || name === "tasks-sweep") &&
    dirname(dirname(real)) === state &&
    ownPasses(basename(dirname(real)))
  )
    return { dir: real, phase: name === "tasks" ? "plan" : "sweep", passes: dirname(real) };
  if (extras.has(real))
    return { dir: real, phase: name === "tasks-sweep" ? "sweep" : "plan", passes: undefined };
  return {
    error: `${input}: not a round's task directory (only state/pr-<n>-round-<k>-passes/tasks or …/tasks-sweep)`,
  };
}

/** The discovery task files of one dir, in row order (= the daemon's launch
 * order). Regular files only: a symlink is never followed. */
function listTaskFiles(dir: string): Array<{ row: number; agent: string; file: string }> {
  const out: Array<{ row: number; agent: string; file: string }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const m = TASK_FILE_RE.exec(entry.name);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    if (VALIDATOR_AGENT_RE.test(m[2])) continue;
    out.push({ row: Number.parseInt(m[1], 10), agent: m[2], file: entry.name });
  }
  return out.sort((a, b) => a.row - b.row || a.file.localeCompare(b.file));
}

/** The keys a unit answers to in `extra` and `skip`: its file name (with or
 * without `.md`), its row (`3`, or `sweep:3` for a sweep row), its agent, its
 * phase's wildcard (`plan:*` / `sweep:*`) and `*`. */
export function unitKeys(u: Pick<LaunchUnit, "phase" | "row" | "file" | "agent">): string[] {
  const row = u.phase === "sweep" ? `sweep:${u.row}` : String(u.row);
  return [u.file, u.file.replace(/\.md$/, ""), row, u.agent, `${u.phase}:*`, "*"];
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) return undefined;
  return value as string[];
}

/**
 * Plan a launch: resolve and confine the dirs, list their discovery task
 * files, apply `skip` and `extra`. Pure over the filesystem it reads; never
 * throws — every refusal is an `{ ok: false }` with the reason.
 */
export function planLaunch(
  params: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): LaunchPlan {
  try {
    const dirs = stringList(params.dirs ?? params.dir);
    if (!dirs || dirs.length === 0)
      return { ok: false, error: "`dirs` must name the round's task directory (one or two paths)" };
    if (dirs.length > 2)
      return { ok: false, error: "at most two dirs: the round's tasks and its tasks-sweep" };
    const skip = stringList(params.skip);
    if (!skip) return { ok: false, error: "`skip` must be a list of row keys" };
    const extraRaw = params.extra ?? {};
    if (typeof extraRaw !== "object" || extraRaw === null || Array.isArray(extraRaw))
      return { ok: false, error: "`extra` must map a row key to text" };
    const extra = Object.entries(extraRaw as Record<string, unknown>);
    if (extra.some(([, v]) => typeof v !== "string"))
      return { ok: false, error: "`extra` values must be text" };

    const root = env.QCR_SANDBOX_ROOT?.trim() || process.cwd();
    const realRoot = realDir(root);
    if (!realRoot) return { ok: false, error: `sandbox root ${root} is not readable` };
    const extras = sanctionedExtras(env);

    const resolved: Array<{ dir: string; phase: "plan" | "sweep"; passes: string | undefined }> =
      [];
    for (const d of dirs) {
      const r = resolveTaskDir(d, realRoot, extras, env.QCR_PR?.trim() || undefined);
      if ("error" in r) return { ok: false, error: r.error };
      if (resolved.some((x) => x.dir === r.dir)) continue;
      if (resolved.some((x) => x.phase === r.phase))
        return { ok: false, error: `two ${r.phase} task directories in one launch` };
      if (resolved.some((x) => x.passes !== r.passes))
        return { ok: false, error: "the two task directories belong to different rounds" };
      resolved.push(r);
    }
    // Plan rows first, then the sweep's — the daemon's launch order within each.
    resolved.sort((a, b) => (a.phase === b.phase ? 0 : a.phase === "plan" ? -1 : 1));

    const all: LaunchUnit[] = [];
    for (const r of resolved) {
      for (const f of listTaskFiles(r.dir)) {
        const path = join(r.dir, f.file);
        all.push({ phase: r.phase, ...f, path, task: taskPointer(path) });
      }
    }
    if (all.length === 0)
      return {
        ok: false,
        error: `no discovery task files in ${resolved.map((r) => r.dir).join(", ")}`,
      };

    // Every key must hit a row: a typo must never silently drop the prior
    // findings the session meant to assign, nor launch a row it meant to raise.
    const hits = (key: string) => all.filter((u) => unitKeys(u).includes(key));
    for (const key of skip)
      if (hits(key).length === 0) return { ok: false, error: `skip: no row answers to "${key}"` };
    for (const [key] of extra)
      if (hits(key).length === 0) return { ok: false, error: `extra: no row answers to "${key}"` };

    const skipped = all.filter((u) => skip.some((k) => unitKeys(u).includes(k)));
    const units = all
      .filter((u) => !skipped.includes(u))
      .map((u) => {
        const added = extra
          .filter(([k]) => unitKeys(u).includes(k))
          .map(([, v]) => (v as string).trim())
          .filter((v) => v);
        return added.length ? { ...u, task: [u.task, ...added].join("\n\n") } : u;
      });
    if (units.length === 0) return { ok: false, error: "every row was skipped: nothing to launch" };
    return { ok: true, units, skipped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** An error result, never a throw (VERIFY-ON-PIN: pi renders a returned
 * `isError` result to the model as a failed tool call — the native subagent
 * tool returns its own failures the same way). */
function launchError(error: string): Awaited<ReturnType<ToolExecute>> {
  return {
    content: [
      {
        type: "text" as const,
        text: `launch_plan: ${error}. Nothing was launched — launch the rows with the subagent tool, all in this one turn.`,
      },
    ],
    details: { launch_plan: { error } },
    isError: true,
  } as Awaited<ReturnType<ToolExecute>>;
}

/** The `launch_plan` tool's execute over the subagent tool's WRAPPED execute
 * (sanitizer + semaphore + wide fan-out): one `tasks:[…]` call. */
export function launchPlanExecute(
  wrapped: ToolExecute,
  env: Record<string, string | undefined> = process.env,
): ToolExecute {
  return async function launchPlan(this: unknown, id, params, signal, onUpdate, ctx) {
    const plan = planLaunch(params ?? {}, env);
    if (!plan.ok) return launchError(plan.error);
    const tasks = plan.units.map((u) => ({ agent: u.agent, task: u.task }));
    const result = await wrapped.call(this, id, { tasks }, signal, onUpdate, ctx);
    const summary = {
      launched: plan.units.map((u) => ({ phase: u.phase, row: u.row, agent: u.agent })),
      skipped: plan.skipped.map((u) => ({ phase: u.phase, row: u.row, agent: u.agent })),
    };
    return { ...result, details: { ...result.details, launch_plan: summary } };
  };
}

/** The `launch_plan` tool definition. Parameters are plain JSON Schema
 * (VERIFY-ON-PIN: equivalent to TypeBox at runtime — pi-api.d.ts). */
export function launchPlanDefinition(
  wrapped: ToolExecute,
  env: Record<string, string | undefined> = process.env,
): PiToolDefinition {
  return {
    name: LAUNCH_PLAN_TOOL,
    label: "Launch plan",
    description:
      "Launch EVERY discovery lens of this review round in one call, from the task files the daemon wrote " +
      "(state/pr-<n>-round-<k>-passes/tasks, and the pre-approval sweep's …/tasks-sweep). Each lens gets its " +
      "task-file pointer as its task, plus any `extra` text keyed to its row. Never launches pass-validate. " +
      "Returns the same result the subagent tool returns for a parallel call.",
    parameters: {
      type: "object",
      properties: {
        dirs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 2,
          description:
            "The round's task directory (…-passes/tasks, or the …-passes dir itself), and optionally the sweep's " +
            "…-passes/tasks-sweep to launch an early sweep in the same call.",
        },
        extra: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Optional text appended after a row's pointer (prior findings assigned to that lens, a site, a " +
            "question). Key: the row number as the plan table prints it (`sweep:<row>` for a sweep row), the " +
            "task file name, the agent name (every row of that agent), `sweep:*` / `plan:*` (every row of " +
            "that phase) or `*` (every row).",
        },
        skip: {
          type: "array",
          items: { type: "string" },
          description:
            "Rows (same keys as `extra`) NOT to launch here because you launch them yourself through the " +
            "subagent tool in this same turn at a RAISED tier.",
        },
      },
      required: ["dirs"],
    },
    execute: launchPlanExecute(wrapped, env),
  };
}

/** The native extension's path inside the installed pi package. */
export function nativeExtensionPath(examplesPath: string): string {
  return join(examplesPath, "extensions", "subagent", "index.ts");
}

export default async function activate(pi: Pi): Promise<void> {
  const log = (msg: string) => console.error(msg);

  let factory: (api: unknown) => void | Promise<void>;
  let version = "unknown";
  try {
    // Resolved inside the pi process, so the import can only ever see the
    // installed (= pinned) package — the drift-free sourcing in the header.
    const pkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      getExamplesPath(): string;
      VERSION?: string;
    };
    version = pkg.VERSION ?? "unknown";
    const mod = (await import(nativeExtensionPath(pkg.getExamplesPath()))) as {
      default?: (api: unknown) => void | Promise<void>;
    };
    if (typeof mod.default !== "function")
      throw new Error("native subagent extension has no default export");
    factory = mod.default;
  } catch (err) {
    // Loud, unmissable, never a crashed pi: without the tool every planned
    // lens spawn fails and the round templates order STOP + anomaly rather
    // than a stand-in (same degrade stance as the old register-lens-agents).
    log(
      `subagents: FATAL — could not load pi's native subagent extension (pi ${version}): ` +
        `${err instanceof Error ? err.message : String(err)}. The subagent tool will NOT exist in this session.`,
    );
    return;
  }

  const maxConcurrency = resolveMaxConcurrency();
  const scope = resolveScope();
  const semaphore = new WeightedSemaphore(maxConcurrency);

  // Hand the native factory a shim that intercepts registerTool and wraps the
  // subagent tool's execute; everything else passes through bound to the real
  // API (bind keeps pi's own `this` for its class methods).
  const shim = new Proxy(pi, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (definition: PiToolDefinition) => {
          const real = target.registerTool?.bind(target);
          if (!real) {
            log("subagents: DEGRADED — pi.registerTool unavailable; subagent tool not registered.");
            return;
          }
          if (definition?.name === "subagent" && typeof definition.execute === "function") {
            const wrapped = wrapExecute(definition.execute.bind(definition), semaphore);
            real({ ...definition, execute: wrapped });
            // launch_plan rides the same wrapped execute, so it exists exactly
            // where the subagent tool does and shares its semaphore.
            real(launchPlanDefinition(wrapped));
            log(
              `subagents: native subagent tool registered (pi ${version}, scope=${scope}, ` +
                `max_concurrency=${maxConcurrency}, fanout=${resolveWideFanout() ? "wide" : "native"}; ` +
                `${LAUNCH_PLAN_TOOL} registered)`,
            );
          } else {
            real(definition);
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  await factory(shim);
}
