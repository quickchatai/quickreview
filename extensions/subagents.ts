// subagents — first-party glue over pi's own subagent extension.
//
// No third-party subagent extension is used: pi ships a first-party one
// inside the pinned npm package. This file is the one loader for that native
// extension, on both surfaces (VM sessions via
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
//     run with no cap at all, because pi dispatches a turn's tool calls via
//     Promise.all. The weighted semaphore below is the process-wide cap
//     (default 4; the VM passes its own via QCR_SUBAGENT_MAX_CONCURRENCY,
//     from config.toml [pi] subagent_max_concurrency).
//
//  3. **Child processes must never see repo-controlled pi config.** Native
//     children spawn as `pi --mode json -p --no-session` without
//     `--no-extensions`, so a child's cwd decides which project `.pi/`
//     resources it loads — and
//     `defaultProjectTrust = "always"` (the no-stall decision) trusts them
//     all. A task `cwd` pointing into a reviewed-repo worktree would load
//     that repo's `.pi/extensions` into a reviewer child. The sanitizer
//     therefore strips every `cwd` param (top-level, tasks[], chain[]): a
//     child always runs in the parent session's own cwd (the sandbox root /
//     /workspace — first-party ground), and passes address the worktree by
//     absolute path exactly as their task strings already do. It also pins
//     `agentScope` (default "user": agents come from ~/.pi/agent/agents,
//     which both entrypoints symlink to the sanctioned agent dir — built
//     state/agents on the VM, docker/companion/agents in the companion) and
//     forces `confirmProjectAgents: false` (never an interactive modal).
//
// Beside the wrapped subagent tool the glue registers `launch_plan` (below):
// the round's discovery task files launched as ONE call through the same
// wrapped execute, so the one-turn launch the round templates ask for is
// one tool call rather than a discipline.
//
// What stays structural without any glue: children never gain the `subagent`
// tool (this extension rides per-spawn argv, never the global settings.json,
// and children load only global extensions, plus leaf-cache.ts in a round
// with a context pack, below), so a pass cannot fan out — the
// single-shepherd leaves rule (root CLAUDE.md rule 9). Children do load the
// globally-registered bash-guard, so the exec policy binds them structurally,
// not only through the prompt.
//
// VERIFY-ON-PIN (0.84.4, read statically from the published tarball, and
// the subagent example re-compared byte-identical at 0.87.1, 0.99.1 and 1.0.0; live
// smoke-tested):
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
import { CONTEXT_PACK_FILE, LEAF_PACK_ENV } from "../src/contextpack.js";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { toPiTool, type QcrTool, type QcrToolResult } from "./pi-tool.js";
import { CACHE_GROUP_MAX_AGE_MS, CacheGrouper } from "../src/engine/lens/cache-group.js";
import {
  type ParallelNativeResult,
  minutesText,
  passTimeoutMessage,
  resolvePassDeadlineMs,
  runUnderDeadline,
  soleTask,
  timedOutResult,
} from "../src/engine/lens/deadline.js";
import { planLaunch } from "../src/engine/lens/launch-plan.js";
import { WeightedSemaphore } from "../src/engine/lens/semaphore.js";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

// The pure parts live in src/engine/lens/ (shared with the engine routes);
// every name stays importable from here. The env names they read still reach
// this extension: QCR_SUBAGENT_PASS_DEADLINE_MIN (deadline.ts), QCR_PR and
// QCR_SANDBOX_ROOT (launch-plan.ts). They are named here so the env inventory
// keeps them listed.
export {
  CACHE_GROUP_MAX_AGE_MS,
  CacheGrouper,
  type CacheSlot,
} from "../src/engine/lens/cache-group.js";
export {
  PASS_DEADLINE_ENV,
  minutesText,
  passTimeoutMessage,
  resolvePassDeadlineMs,
  runUnderDeadline,
  soleTask,
  timedOutResult,
  type ParallelNativeResult,
} from "../src/engine/lens/deadline.js";
export {
  LAUNCH_PLAN_DIRS_ENV,
  type LaunchPlan,
  type LaunchUnit,
  listTaskFiles,
  planLaunch,
  realDir,
  resolveTaskDir,
  sanctionedExtras,
  stringList,
  taskPointer,
  unitKeys,
} from "../src/engine/lens/launch-plan.js";
export { WeightedSemaphore } from "../src/engine/lens/semaphore.js";

/** Env var pinning the discovery scope. "user" (default) reads ONLY
 * ~/.pi/agent/agents — repo-controlled `.pi/agents` dirs are unreachable no
 * matter what the model asks for. */
export const SCOPE_ENV = "QCR_SUBAGENT_SCOPE";

/** Env var carrying the process-wide child cap (on the VM, config.toml
 * [pi] subagent_max_concurrency riding the session command line). */
export const CONCURRENCY_ENV = "QCR_SUBAGENT_MAX_CONCURRENCY";

/** Env var switching the wide fan-out on ("1"): a `tasks:[…]` call is split
 * into one-task native calls that run CONCURRENTLY, each under one permit of
 * the process-wide semaphore released when its own pass ends, so one batched
 * launch runs as wide as the
 * configured cap instead of native's in-call four (bench/aacr/PERF.md §1).
 * Absent or anything but "1" ⇒ the native shape (the companion's default).
 * The VM session and the bench set it from `[review] wide_lens_fanout`. */
export const WIDE_FANOUT_ENV = "QCR_SUBAGENT_WIDE_FANOUT";

/** Whether the wide fan-out is on for this process. */
export function resolveWideFanout(env: Record<string, string | undefined> = process.env): boolean {
  return (env[WIDE_FANOUT_ENV] ?? "").trim() === "1";
}

/** Default process-wide cap — the companion's desktop number. */
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

/** The subagent tool's execute as this glue calls it: a Promise-returning
 * `QcrTool["execute"]`. */
type ToolExecute = (
  id: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
  onUpdate?: unknown,
  ctx?: Parameters<QcrTool["execute"]>[4],
) => Promise<QcrToolResult>;

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

/** Advisory progress may be malformed; only the final result is authoritative. */
function nativeProgress(
  notify: ((value: ParallelNativeResult) => void) | undefined,
): ((update: unknown) => void) | undefined {
  return notify
    ? (update: unknown) => {
        let value: ParallelNativeResult;
        try {
          value = parallelResult(update);
        } catch {
          return;
        }
        notify(value);
      }
    : undefined;
}

function combinedParallel(
  last: ParallelNativeResult | undefined,
  results: unknown[],
  rendered: string[],
  anyError: boolean,
) {
  return {
    ...last,
    content: [{ type: "text" as const, text: renderedParallelContent(results, rendered) }],
    details: { ...last?.details, mode: "parallel", results },
    ...(anyError ? { isError: true } : {}),
  };
}

function configuredDeadline<T>(
  attempt: (signal: AbortSignal) => Promise<T>,
  agent: string,
  signal: AbortSignal | undefined,
  deadlineMs: number,
): Promise<T | "timed_out"> {
  return runUnderDeadline(attempt, signal, deadlineMs, (n) => logPassTimeout(agent, deadlineMs, n));
}

/** Wrap the native tool's execute with the sanitizer + the semaphore. */
export function wrapExecute(
  execute: ToolExecute,
  semaphore: WeightedSemaphore,
  env: Record<string, string | undefined> = process.env,
): ToolExecute {
  return async function wrapped(this: unknown, id, params, signal, onUpdate, ctx) {
    const safe = sanitizeParams(params ?? {}, env);
    if (
      (resolveWideFanout(env) || resolvePassDeadlineMs(env) !== undefined) &&
      Array.isArray(safe.tasks) &&
      safe.tasks.length > 1
    ) {
      return await runWide.call(this, execute, semaphore, id, safe, signal, onUpdate, ctx, env);
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
      const deadlineMs = resolvePassDeadlineMs(env);
      const sole = soleTask(safe);
      if (deadlineMs !== undefined && sole) {
        const value = await configuredDeadline(
          async (attemptSignal) => await execute.call(this, id, safe, attemptSignal, onUpdate, ctx),
          sole.agent,
          signal,
          deadlineMs,
        );
        return value === "timed_out"
          ? (timedOutResult(sole, deadlineMs) as unknown as Awaited<ReturnType<ToolExecute>>)
          : value;
      }
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
        const chunkUpdate = nativeProgress(
          notify
            ? (value) => {
                notify({
                  ...value,
                  details: {
                    ...value.details,
                    mode: "parallel",
                    results: [...allResults, ...value.details.results],
                  },
                });
              }
            : undefined,
        );
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

      return combinedParallel(last, allResults, rendered, anyError);
    } finally {
      semaphore.release(weight);
    }
  };
}

/** One line on the session's stderr per deadline hit — the retry and the
 * final failure; the failed slot itself is what round-progress and the
 * daemon record. */
function logPassTimeout(agent: string, deadlineMs: number, attemptNo: number): void {
  console.error(
    attemptNo === 1
      ? `subagents: pass ${agent} exceeded its ${minutesText(deadlineMs)} min deadline — aborted, retrying once`
      : `subagents: ${passTimeoutMessage(agent, deadlineMs)}`,
  );
}

/** A not-yet-reported task's slot, in native's own still-running shape. */
function runningPlaceholder(task: unknown): Record<string, unknown> {
  const fields = typeof task === "object" && task !== null ? (task as Record<string, unknown>) : {};
  return { agent: fields.agent, task: fields.task, exitCode: -1, messages: [] };
}

/**
 * The wide fan-out: one `tasks:[…]` call, every pass launched at once, each
 * as its own one-task native call holding exactly ONE semaphore permit that
 * it releases the moment THAT pass ends. A slow pass therefore
 * never keeps siblings' permits idle, the process-wide cap still binds across
 * every call of the process, and the semaphore's FIFO starts passes in plan
 * order. Results keep task order, and the combined result has the shape the
 * sequential path returns.
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
  env: Record<string, string | undefined>,
): Promise<Awaited<ReturnType<ToolExecute>>> {
  const tasks = safe.tasks as unknown[];
  const deadlineMs = resolvePassDeadlineMs(env);
  // Every pass's slot stands in the combined update from the start, as the
  // still-running placeholder native itself emits (`exitCode: -1`), so a pass
  // that reports before an earlier one never shifts that earlier one out of
  // its position: position i of every update is task i (round-progress keys
  // its slots by position).
  const partial: unknown[][] = tasks.map((task) => [runningPlaceholder(task)]);
  const notify =
    typeof onUpdate === "function"
      ? (onUpdate as unknown as (update: ParallelNativeResult) => void)
      : undefined;
  const nativeSlots = resolveWideFanout(env)
    ? undefined
    : new WeightedSemaphore(NATIVE_IN_CALL_CONCURRENCY);
  const values = await Promise.all(
    tasks.map(async (task, index) => {
      await nativeSlots?.acquire(1);
      try {
        const passUpdate = notify
          ? (value: ParallelNativeResult) => {
              partial[index] = value.details.results;
              notify({
                ...value,
                details: { ...value.details, mode: "parallel", results: partial.flat() },
              });
            }
          : undefined;
        const value = await runPass.call(
          this,
          execute,
          semaphore,
          id,
          { ...safe, tasks: [task] },
          signal,
          passUpdate,
          ctx,
          deadlineMs,
        );
        partial[index] = value.details.results;
        return value;
      } finally {
        nativeSlots?.release(1);
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
  return combinedParallel(last, allResults, rendered, anyError);
}

/**
 * One pass of the wide fan-out: wait for one permit, run the one-task native
 * call, release the permit when it ends however it ends. With a per-pass
 * deadline the call runs under `runUnderDeadline`: a timed-out attempt is
 * retried once with a fresh deadline, and a second timeout becomes this
 * pass's failed result — the siblings' results are untouched.
 *
 * The permit is KEPT across the retry. The killed child has exited before
 * native's call rejects (it throws only after the process closed), so the
 * retry's child takes the slot the dead one held and the process-wide cap
 * still binds; releasing and re-queueing would put a pass that already cost
 * a whole deadline behind every waiting pass, lengthening exactly the round
 * the deadline exists to bound.
 */
async function runPass(
  this: unknown,
  execute: ToolExecute,
  semaphore: WeightedSemaphore,
  id: Parameters<ToolExecute>[0],
  params: Record<string, unknown>,
  signal: Parameters<ToolExecute>[2],
  onUpdate: ((update: ParallelNativeResult) => void) | undefined,
  ctx: Parameters<ToolExecute>[4],
  deadlineMs?: number,
): Promise<ParallelNativeResult> {
  await semaphore.acquire(1);
  try {
    // Aborted while parked: never spend the newly-acquired permit on a child.
    signal?.throwIfAborted();
    const passUpdate = nativeProgress(onUpdate);
    const sole = deadlineMs === undefined ? undefined : soleTask(params);
    if (deadlineMs === undefined || !sole) {
      return parallelResult(await execute.call(this, id, params, signal, passUpdate, ctx));
    }
    const value = await configuredDeadline(
      async (attemptSignal) =>
        parallelResult(await execute.call(this, id, params, attemptSignal, passUpdate, ctx)),
      sole.agent,
      signal,
      deadlineMs,
    );
    if (value !== "timed_out") return value;
    const failed = timedOutResult(sole, deadlineMs);
    onUpdate?.(failed);
    return failed;
  } finally {
    semaphore.release(1);
  }
}

// ---------------------------------------------------------------------------
// launch_plan — the one-turn discovery launch, made structural.
//
// The round templates ask the PR's main session to launch every discovery
// row in one assistant turn. Left to discipline, a session launches one lens
// per turn or one lens alone and waits, multiplying fan-out time, and spends
// time hand-writing near-identical subagent calls whose whole task is a
// pointer to the task file the daemon already wrote (`[review] task_files`,
// src/passtasks.ts). `launch_plan` reads the round's task directory and
// launches every discovery task file in it as one `tasks:[…]` call through
// the same wrapped execute the subagent tool runs — the same sanitizer, the
// same process-wide semaphore, the same wide fan-out — so the result is exactly what the subagent tool returns and
// the session merges it as before.
//
// Still the main session's act (root CLAUDE.md rule 9): the session calls the
// tool; the daemon schedules nothing. Bounded on purpose:
//  - only a round's sanctioned task dirs — `<sandbox root>/state/pr-<n>-round-
//    <k>-passes/tasks` (the plan), `…/tasks-optional` (a follow-up round's
//    optional rows) and `…/tasks-sweep` (the owed pre-approval sweep), or the
//    pass dir itself, which means its `tasks` — every path
//    resolved through symlinks first; the bench names its case dirs exactly in
//    QCR_LAUNCH_PLAN_DIRS (the session cannot set its own environment);
//  - only regular files named as passtasks.ts names them (`NN-<agent>.md`), so
//    a symlink planted in the dir is never followed;
//  - never the validator (`pass-validate…`): it runs after discovery, over
//    the candidates, and has no task file anyway — excluded here as a belt;
//  - no cwd and no free-form agent: each unit is the row's file-named agent
//    and the pointer the templates prescribe, plus optional `extra` text the
//    session keys to a row (a prior finding to verify, a site to look at).
// Rows the session raises are named in `skip` and launched through the
// subagent tool in the same turn; rows it adds have no file and go there too.

/** The tool's name, as the round templates spell it. */
export const LAUNCH_PLAN_TOOL = "launch_plan";

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
  };
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
 * (a TypeBox schema is plain JSON Schema at runtime). */
export function launchPlanDefinition(
  wrapped: ToolExecute,
  env: Record<string, string | undefined> = process.env,
): QcrTool {
  return {
    name: LAUNCH_PLAN_TOOL,
    label: "Launch plan",
    description:
      "Launch EVERY discovery lens of this review round in one call, from the task files the daemon wrote " +
      "(state/pr-<n>-round-<k>-passes/tasks; a follow-up round's optional rows …/tasks-optional; the pre-approval " +
      "sweep's …/tasks-sweep). Each lens gets its " +
      "task-file pointer as its task, plus any `extra` text keyed to its row. Never launches pass-validate. " +
      "Returns the same result the subagent tool returns for a parallel call.",
    parameters: {
      type: "object",
      properties: {
        dirs: {
          type: "array",
          items: { type: "string" },
          minItems: 1,
          maxItems: 3,
          description:
            "The round's task directory (…-passes/tasks, or the …-passes dir itself), and optionally the " +
            "follow-up round's optional rows (…-passes/tasks-optional) and the sweep's …-passes/tasks-sweep " +
            "(the pre-approval sweep's own launch).",
        },
        extra: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Optional text appended after a row's pointer (prior findings assigned to that lens, a site, a " +
            "question). Key: the row number as the plan table prints it (`sweep:<row>` for a sweep row, " +
            "`optional:<row>` for an optional row), the task file name, the agent name (every row of that " +
            "agent), `plan:*` / `optional:*` / `sweep:*` (every row of that phase) or `*` (every row).",
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

// ---------------------------------------------------------------------------
// The shared prompt cache — lens children in cache groups.
//
// The provider caches a request's prefix, and pi's cache key is its session
// id. Native children run `--no-session`, so every child gets a random id and
// lands on a cold cache, even where prompts are byte-identical.
//
// What the reviewer's backend (ChatGPT login) was measured to do:
//  - an identical prefix is reused across separate pi processes that share a
//    session id: 24,320 of 24,467 tokens; under `--no-session`, 0;
//  - a request that extends a cached one hits however long the extension is
//    (a child's own later turns, and a lens after a warm-up: 23,808 cached
//    beneath a 1,500-word lens text);
//  - but two requests that share a prefix and then diverge share it only when
//    the cached one's tail past the prefix is short (≈60 words hit, ≈250
//    words missed, a 10 s wait made no difference);
//  - a request sent at the same instant as the one that would warm it misses.
//
// So a child's `--no-session` is rewritten, at spawn, to
// `--session-id <group key> --session-dir <its own temp dir>` (the dir is
// removed when the child exits). Children share a key in GROUPS of
// QCR_SUBAGENT_CACHE_GROUP per model (a few children per key, so no one key
// carries a whole round's request rate):
//  - a round without a context pack: every child after a group's first starts
//    QCR_SUBAGENT_CACHE_STAGGER_MS after it, so rows of one agent whose prompts
//    differ only in a short task pointer (the sweep rows) share their prefix;
//  - a round with a context pack (`[review] context_pack`, written beside its
//    task files): the group's first child first spawns a warm-up — the same
//    model and tools, no lens text, the pack and "reply OK" — and every child
//    of the group waits for it to finish (at most CACHE_WARMUP_WAIT_S) before
//    it starts. Each child loads extensions/leaf-cache.ts, which puts the pack
//    ahead of its lens's instructions, so every lens request extends the
//    warm-up's and reads the pack from cache.
// A child that waits does so through `sh -c '…; exec "$@"'`, so once it runs
// it is the child and every signal reaches it.
//
// The spawn is native's own (`spawn` from node:child_process, in
// runSingleAgent); the glue cannot reach its argv any other way without
// vendoring the extension, which the drift-free sourcing above forbids. Only
// a spawn whose argv carries native's exact leaf flags
// (`--mode json -p --no-session`) is touched; every other spawn passes
// through unchanged. A child stays a leaf: `-p` alone marks it so for the
// vendored OpenViking fork's qcr-leaf.ts, and children load no per-spawn
// extension but leaf-cache.ts.
//
// VERIFY-ON-PIN (pi 1.0.0): native builds `["--mode","json","-p","--no-session",
// …,"--model",<spec>,…,"--append-system-prompt",<file>,"Task: <task>"]` and
// spawns it with node:child_process `spawn`, imported after this glue patches
// it (module.syncBuiltinESMExports keeps an ESM binding in step — verified in
// a real pi 1.0.0 parent); `--session-id <id> --session-dir <dir>` runs `-p`
// exactly as `--no-session` does, but keyed (probed).

/** Env var: children per shared cache key; 0 or unset ⇒ `--no-session`. */
export const CACHE_GROUP_ENV = "QCR_SUBAGENT_CACHE_GROUP";
/** Env var: how long a pack-less group's later children start after its first. */
export const CACHE_STAGGER_ENV = "QCR_SUBAGENT_CACHE_STAGGER_MS";
/** Env var: the leaf-cache extension's absolute path (set by the daemon). */
export const LEAF_CACHE_EXT_ENV = "QCR_LEAF_CACHE_EXT";
/** Env var the leaf-cache extension reads in the child: the pack's path. */
export { LEAF_PACK_ENV };
/** The pack's file name beside a round's task dirs (src/contextpack.ts). */
export const LEAF_PACK_FILE = CONTEXT_PACK_FILE;
export const DEFAULT_CACHE_STAGGER_MS = 2500;
/** The longest a packed group's child waits for its warm-up. */
export const CACHE_WARMUP_WAIT_S = 30;
/** The warm-up's whole task: it exists to put the pack in the cache. */
export const WARMUP_TASK = "Task: Reply with the single word OK.";

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export function resolveCacheGroup(env: Record<string, string | undefined> = process.env): number {
  return nonNegativeInt(env[CACHE_GROUP_ENV], 0);
}

export function resolveCacheStagger(env: Record<string, string | undefined> = process.env): number {
  return nonNegativeInt(env[CACHE_STAGGER_ENV], DEFAULT_CACHE_STAGGER_MS);
}

/** The index of `--no-session` when `args` carries native's exact leaf flag
 * run (`--mode json -p --no-session`), else -1. */
export function leafNoSessionIndex(args: readonly string[]): number {
  for (let i = 0; i + 3 < args.length; i += 1) {
    if (
      args[i] === "--mode" &&
      args[i + 1] === "json" &&
      args[i + 2] === "-p" &&
      args[i + 3] === "--no-session"
    )
      return i + 3;
  }
  return -1;
}

/** The `--model` spec of a child argv ("" when it has none). */
export function modelOf(args: readonly string[]): string {
  const i = args.indexOf("--model");
  return i >= 0 ? (args[i + 1] ?? "") : "";
}

const TASK_FILE_POINTER_RE = /Task file: (\/\S+?\.md)\. /;

/** The round's pack for a child whose task is a task-file pointer: the
 * `context-pack.md` beside the task's directory, when it is a regular file. */
export function packForTask(
  args: readonly string[],
  isFile: (path: string) => boolean,
): string | undefined {
  const last = args[args.length - 1];
  if (typeof last !== "string" || !last.startsWith("Task: ")) return undefined;
  const m = TASK_FILE_POINTER_RE.exec(last);
  if (!m || m[1] === undefined) return undefined;
  const pack = join(dirname(dirname(m[1])), LEAF_PACK_FILE);
  return isFile(pack) ? pack : undefined;
}

/** A spawn the patch makes: what to run, and the temp dir to remove after. */
export interface LeafSpawn {
  command: string;
  args: string[];
  options: Record<string, unknown> | undefined;
  sessionDir: string;
}

/** The rewrite of one leaf spawn: the child itself, and — for a packed
 * group's first child — the warm-up to spawn before it, with the file its
 * finish creates (every child of the group waits for that file). */
export interface LeafRewrite {
  child: LeafSpawn;
  /** The warm-up's spawn, and its ready file — in `readyDir`, its own dir,
   * which outlives the warm-up so the waiting children can see the file. */
  warmup?: { spawn: LeafSpawn; readyFile: string; readyDir: string };
}

/** `sh -c` that waits for `readyFile` (at most `maxS` seconds), then execs. */
function waitingFor(readyFile: string, maxS: number, command: string, args: string[]) {
  return {
    command: "/bin/sh",
    args: [
      "-c",
      `i=0; while [ ! -e "$0" ] && [ "$i" -lt ${maxS * 10} ]; do sleep 0.1; i=$((i+1)); done; exec "$@"`,
      readyFile,
      command,
      ...args,
    ],
  };
}

/** The rewritten spawn of a leaf child, or undefined to spawn it unchanged. */
export function rewriteLeafSpawn(
  command: string,
  args: readonly string[],
  options: Record<string, unknown> | undefined,
  deps: {
    grouper: CacheGrouper;
    now: () => number;
    makeSessionDir: () => string;
    isFile: (path: string) => boolean;
    leafCacheExt: string | undefined;
    baseEnv: Record<string, string | undefined>;
    /** The ready file of a packed group's warm-up, by group key. */
    warmups: Map<string, string>;
  },
): LeafRewrite | undefined {
  const at = leafNoSessionIndex(args);
  if (at < 0) return undefined;
  const slot = deps.grouper.next(deps.now(), modelOf(args));
  const pack = deps.leafCacheExt ? packForTask(args, deps.isFile) : undefined;
  const keyed = (dir: string) => ["--session-id", slot.key, "--session-dir", dir];
  const packEnv = pack
    ? { ...((options?.env as typeof deps.baseEnv) ?? deps.baseEnv), [LEAF_PACK_ENV]: pack }
    : undefined;
  const ext = pack ? ["--extension", deps.leafCacheExt as string] : [];

  const sessionDir = deps.makeSessionDir();
  let next = [...args.slice(0, at), ...keyed(sessionDir), ...ext, ...args.slice(at + 1)];
  const opts = packEnv ? { ...options, env: packEnv } : options;

  let warmup: LeafRewrite["warmup"];
  if (pack && slot.first) {
    // The group's warm-up: the child's own argv without its lens text, the
    // task replaced by WARMUP_TASK — so its request is exactly the shared
    // prefix the group's lens requests extend.
    const warmDir = deps.makeSessionDir();
    const readyDir = deps.makeSessionDir();
    const readyFile = join(readyDir, "warm.ready");
    const base = args.slice(at + 1, -1);
    const sp = base.indexOf("--append-system-prompt");
    const noLens = sp >= 0 ? [...base.slice(0, sp), ...base.slice(sp + 2)] : base;
    warmup = {
      readyFile,
      readyDir,
      spawn: {
        command,
        args: [...args.slice(0, at), ...keyed(warmDir), ...ext, ...noLens, WARMUP_TASK],
        options: opts,
        sessionDir: warmDir,
      },
    };
    deps.warmups.set(slot.key, readyFile);
  }
  const ready = pack ? deps.warmups.get(slot.key) : undefined;
  let cmd = command;
  if (ready) {
    ({ command: cmd, args: next } = waitingFor(ready, CACHE_WARMUP_WAIT_S, command, next));
  } else if (slot.delayMs > 0) {
    next = ["-c", 'sleep "$0"; exec "$@"', (slot.delayMs / 1000).toFixed(2), command, ...next];
    cmd = "/bin/sh";
  }
  return {
    child: { command: cmd, args: next, options: opts, sessionDir },
    ...(warmup ? { warmup } : {}),
  };
}

const LEAF_PATCHED = Symbol.for("qcr.leafSpawnPatched");

/** Patch node:child_process `spawn` so native's leaf children run keyed (see
 * above). Idempotent; does nothing when the cache group is 0. Returns whether
 * the patch is in place. Must run BEFORE the native extension is imported. */
export function installLeafSpawnPatch(
  env: Record<string, string | undefined> = process.env,
  log: (msg: string) => void = (m) => console.error(m),
): boolean {
  const size = resolveCacheGroup(env);
  if (size <= 0) return false;
  const cp = createRequire(resolve("qcr-leaf-spawn.js"))("node:child_process") as {
    spawn: ((...a: unknown[]) => unknown) & { [LEAF_PATCHED]?: boolean };
  };
  if (cp.spawn[LEAF_PATCHED]) return true;
  const real = cp.spawn;
  const deps = {
    grouper: new CacheGrouper(size, resolveCacheStagger(env)),
    now: () => Date.now(),
    makeSessionDir: () => mkdtempSync(join(tmpdir(), "qcr-leaf-")),
    isFile: (path: string) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    },
    leafCacheExt: env[LEAF_CACHE_EXT_ENV]?.trim() || undefined,
    baseEnv: process.env as Record<string, string | undefined>,
    warmups: new Map<string, string>(),
  };
  // Ready dirs still waiting out their group, removed at the latest when this
  // process exits (a short-lived parent never reaches the timer).
  const readyDirs = new Set<string>();
  process.once("exit", () => {
    for (const d of readyDirs) rmSync(d, { recursive: true, force: true });
  });
  type Child = { once(event: string, fn: () => void): void };
  const start = (self: unknown, s: LeafSpawn, after?: () => void): Child => {
    const child = real.call(self, s.command, s.args, s.options) as Child;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      after?.();
      rmSync(s.sessionDir, { recursive: true, force: true });
    };
    child.once("close", finish);
    child.once("error", finish);
    return child;
  };
  const patched = function (this: unknown, ...a: unknown[]): unknown {
    const [command, args, options] = a;
    let r: LeafRewrite | undefined;
    try {
      r =
        typeof command === "string" && Array.isArray(args)
          ? rewriteLeafSpawn(
              command,
              args as string[],
              options as Record<string, unknown> | undefined,
              deps,
            )
          : undefined;
    } catch (err) {
      log(`subagents: cache key not applied (${err instanceof Error ? err.message : String(err)})`);
      r = undefined;
    }
    if (!r) return real.apply(this, a);
    if (r.warmup) {
      // The warm-up's finish — success or not — releases its group: the
      // children wait for the ready file's EXISTENCE only (or run out their
      // wait). The ready dir outlives the group's children, then goes.
      const { readyFile, readyDir } = r.warmup;
      readyDirs.add(readyDir);
      start(this, r.warmup.spawn, () => {
        try {
          writeFileSync(readyFile, "");
        } catch {
          /* the children's wait runs out instead */
        }
        setTimeout(() => {
          rmSync(readyDir, { recursive: true, force: true });
          readyDirs.delete(readyDir);
        }, CACHE_GROUP_MAX_AGE_MS + 60_000).unref();
      });
    }
    return start(this, r.child);
  } as typeof cp.spawn;
  patched[LEAF_PATCHED] = true;
  cp.spawn = patched;
  syncBuiltinESMExports();
  return true;
}

/** The native extension's path inside the installed pi package. */
export function nativeExtensionPath(examplesPath: string): string {
  return join(examplesPath, "extensions", "subagent", "index.ts");
}

export default async function activate(pi: ExtensionAPI): Promise<void> {
  const log = (msg: string) => console.error(msg);
  // Before native is imported, so its `spawn` is the patched one.
  const cacheGroups = installLeafSpawnPatch(process.env, log);

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
    // than a stand-in.
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
        return (definition: ToolDefinition) => {
          const real = target.registerTool?.bind(target);
          if (!real) {
            log("subagents: DEGRADED — pi.registerTool unavailable; subagent tool not registered.");
            return;
          }
          if (definition?.name === "subagent" && typeof definition.execute === "function") {
            const wrapped = wrapExecute(
              definition.execute.bind(definition) as ToolExecute,
              semaphore,
            );
            real({ ...definition, execute: wrapped });
            // launch_plan rides the same wrapped execute, so it exists exactly
            // where the subagent tool does and shares its semaphore.
            real(toPiTool(launchPlanDefinition(wrapped)));
            log(
              `subagents: native subagent tool registered (pi ${version}, scope=${scope}, ` +
                `max_concurrency=${maxConcurrency}, fanout=${resolveWideFanout() ? "wide" : "native"}, ` +
                `pass_deadline=${resolvePassDeadlineMs() === undefined ? "off" : `${minutesText(resolvePassDeadlineMs()!)} min, one retry`}; ` +
                `${LAUNCH_PLAN_TOOL} registered; cache groups ` +
                `${cacheGroups ? `of ${resolveCacheGroup()}, stagger ${resolveCacheStagger()} ms` : "off"})`,
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
