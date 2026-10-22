// Our lens tools: `lens` and `lens_wave` (owner ruling D3), the engine routes'
// replacement for pi's native `subagent` and the glue's `launch_plan` (retired,
// P9.4); a consumer still reads all four, for the transcripts and ledgers of
// older rounds (src/lensresult.ts isLensTool).
//
//   lens        one pass, `{agent, task}`, or several at once, `{tasks: [...]}`:
//               the rows the session raises, the lenses it adds, the validator.
//   lens_wave   the round's planned discovery wave, from the task files the
//               engine wrote (dirs: the round's tasks, tasks-optional and
//               tasks-sweep, bounded and confined exactly as launch_plan's are,
//               with the same `extra` / `skip`). The engine launches that wave
//               itself at round start, so `lens_wave` JOINS it (D8): a row that
//               is running is waited for, a row that is done is returned, and
//               a row that was never started is started. Nothing runs twice.
//
// Both return what the native tools return, so every consumer reads them
// unchanged: `details.results` holds one LensResult v1 per pass (with the run's
// `id`, which is how a pass joined by two calls is counted once), `details.mode`
// is `single` or `parallel`, and a pass still running reports `exitCode: -1`
// in the updates. The tools run passes on a LensRunner (runlens.ts): the cap,
// the cache groups and the retry-once deadline are the runner's, not theirs.
// This module touches no pi SDK; extensions/lens.ts and the round's hosting
// give the definitions to pi.
import { LENS_TOOL, LENS_WAVE_TOOL, type LensResult } from "../../lensresult.js";
import { textResult, type QcrTool, type QcrToolResult } from "../../../extensions/pi-tool.js";
import { planLaunch, type LaunchUnit } from "./launch-plan.js";
import type { LensRun } from "./runlens.js";
import { runSafely, type LensWave, type WaveRow, type WaveRunner } from "./wave.js";

export { LENS_TOOL, LENS_WAVE_TOOL };

/** More passes than this in one `lens` call is a mistake, not a plan. */
export const MAX_LENS_TASKS = 64;

/** A pass's text in a parallel result is cut here, as the native tool cuts it;
 * the whole of it stays in `details`. */
export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface LensToolDeps {
  /** Starts a pass. The runner's cap and cache groups bound the fan-out. */
  runner: WaveRunner;
  /** The round's rows in flight. */
  wave: LensWave;
  /** The session's environment: `lens_wave` resolves its dirs against it
   * (QCR_SANDBOX_ROOT, QCR_PR, QCR_LAUNCH_PLAN_DIRS), as launch_plan does. */
  env: Readonly<Record<string, string | undefined>>;
}

type Execute = QcrTool["execute"];
type Update = (partial: QcrToolResult) => void;

const ZERO_USAGE = { input: 0, output: 0, cacheRead: 0, cost: 0 };

const isFailed = (r: Pick<LensResult, "exitCode" | "stopReason">): boolean =>
  r.exitCode !== 0 || r.stopReason === "error" || r.stopReason === "aborted";

function truncated(output: string): string {
  const bytes = Buffer.byteLength(output, "utf8");
  if (bytes <= PER_TASK_OUTPUT_CAP) return output;
  let cut = output.slice(0, PER_TASK_OUTPUT_CAP);
  while (Buffer.byteLength(cut, "utf8") > PER_TASK_OUTPUT_CAP) cut = cut.slice(0, -1);
  return `${cut}\n\n[Output truncated: ${bytes - Buffer.byteLength(cut, "utf8")} bytes omitted. Full output preserved in tool details.]`;
}

function outputOf(run: LensRun): string {
  return (isFailed(run.result) ? run.result.errorMessage : undefined) || run.text || "(no output)";
}

/** A pass that has not reported yet, in the native tool's still-running shape. */
function placeholder(agent: string, task: string): Record<string, unknown> {
  return { agent, task, exitCode: -1, messages: [], usage: ZERO_USAGE };
}

/** One slot of `details.results`: the pass's LensResult v1 and the task it ran. */
function slot(run: LensRun, task: string): Record<string, unknown> {
  return { ...run.result, task };
}

function error(tool: string, message: string, hint: string): QcrToolResult {
  return {
    ...textResult(`${tool}: ${message}. ${hint}`, { [tool]: { error: message } }),
    isError: true,
  };
}

/** The result of a parallel call: the native summary text, `details.results`
 * in the order asked. */
function parallelResult(
  entries: ReadonlyArray<{ agent: string; task: string; run: LensRun | undefined }>,
  extraDetails: Record<string, unknown> = {},
): QcrToolResult {
  const finished = entries.filter((e) => e.run !== undefined);
  const succeeded = finished.filter((e) => !isFailed(e.run!.result)).length;
  const summaries = entries.map((e) => {
    if (e.run === undefined) return `### [${e.agent}] still running\n\n(no output yet)`;
    const status = isFailed(e.run.result)
      ? `failed${e.run.result.stopReason && e.run.result.stopReason !== "end" ? ` (${e.run.result.stopReason})` : ""}`
      : "completed";
    return `### [${e.agent}] ${status}\n\n${truncated(outputOf(e.run))}`;
  });
  return textResult(
    `Parallel: ${succeeded}/${entries.length} succeeded\n\n${summaries.join("\n\n---\n\n")}`,
    {
      mode: "parallel",
      results: entries.map((e) => (e.run ? slot(e.run, e.task) : placeholder(e.agent, e.task))),
      ...extraDetails,
    },
  );
}

function progressUpdate(
  entries: ReadonlyArray<{ agent: string; task: string; run: LensRun | undefined }>,
  extraDetails: Record<string, unknown> = {},
): QcrToolResult {
  const done = entries.filter((e) => e.run !== undefined).length;
  return textResult(
    `Parallel: ${done}/${entries.length} done, ${entries.length - done} running...`,
    {
      mode: "parallel",
      results: entries.map((e) => (e.run ? slot(e.run, e.task) : placeholder(e.agent, e.task))),
      ...extraDetails,
    },
  );
}

interface Entry {
  agent: string;
  task: string;
  run: LensRun | undefined;
}

/**
 * Wait for every entry's run, telling `onUpdate` each time one lands. Resolves
 * early, with whatever has landed, when `signal` aborts; the runs themselves are
 * ended by the signal only where the caller handed it to them.
 */
async function awaitEntries(
  entries: Entry[],
  runs: ReadonlyArray<Promise<LensRun>>,
  signal: AbortSignal | undefined,
  onUpdate: Update | undefined,
  extraDetails: Record<string, unknown>,
): Promise<"done" | "aborted"> {
  let stop: (() => void) | undefined;
  const aborted = new Promise<"aborted">((resolve) => {
    if (signal === undefined) return;
    if (signal.aborted) return resolve("aborted");
    stop = () => resolve("aborted");
    signal.addEventListener("abort", stop, { once: true });
  });
  const landed = Promise.all(
    runs.map(async (p, i) => {
      const run = await p;
      entries[i]!.run = run;
      try {
        onUpdate?.(progressUpdate(entries, extraDetails));
      } catch {
        // a progress listener's failure is not the call's
      }
    }),
  ).then(() => "done" as const);
  try {
    return await Promise.race([landed, aborted]);
  } finally {
    if (stop !== undefined) signal?.removeEventListener("abort", stop);
  }
}

// ---- lens ----------------------------------------------------------------

interface LensCall {
  mode: "single" | "parallel";
  tasks: Array<{ agent: string; task: string }>;
}

function readLensCall(params: Record<string, unknown>): LensCall | string {
  if (params["chain"] !== undefined)
    return "`chain` is not supported: launch each lens yourself, or several at once with `tasks`";
  const hasTasks = params["tasks"] !== undefined;
  const hasSingle = params["agent"] !== undefined || params["task"] !== undefined;
  if (hasTasks && hasSingle) return "give `agent` and `task`, or `tasks`, not both";
  if (hasTasks) {
    const raw = params["tasks"];
    if (!Array.isArray(raw) || raw.length === 0) return "`tasks` must be a non-empty list";
    if (raw.length > MAX_LENS_TASKS) return `at most ${MAX_LENS_TASKS} tasks in one call`;
    const tasks: LensCall["tasks"] = [];
    for (const [i, t] of raw.entries()) {
      const o = typeof t === "object" && t !== null ? (t as Record<string, unknown>) : {};
      if (
        typeof o["agent"] !== "string" ||
        typeof o["task"] !== "string" ||
        !o["agent"] ||
        !o["task"]
      )
        return `tasks[${i}] needs an \`agent\` and a \`task\``;
      tasks.push({ agent: o["agent"], task: o["task"] });
    }
    return { mode: "parallel", tasks };
  }
  if (typeof params["agent"] !== "string" || typeof params["task"] !== "string")
    return "give `agent` and `task`, or `tasks`";
  if (!params["agent"] || !params["task"]) return "give `agent` and `task`, or `tasks`";
  return { mode: "single", tasks: [{ agent: params["agent"], task: params["task"] }] };
}

/** The `lens` tool's execute. */
export function lensExecute(deps: LensToolDeps): Execute {
  return async function lens(_id, params, signal, onUpdate) {
    const call = readLensCall(params ?? {});
    if (typeof call === "string") return error(LENS_TOOL, call, "Nothing was launched.");
    const update = onUpdate as Update | undefined;
    const runs = call.tasks.map((t) =>
      runSafely(deps.runner, { agent: t.agent, task: t.task, ...(signal ? { signal } : {}) }),
    );
    const entries: Entry[] = call.tasks.map((t) => ({ ...t, run: undefined }));
    const outcome = await awaitEntries(entries, runs, signal, update, {});
    if (call.mode === "parallel") {
      const result = parallelResult(entries);
      return outcome === "aborted" ? { ...result, isError: true } : result;
    }
    const run = entries[0]!.run;
    const only = call.tasks[0]!;
    if (run === undefined)
      return {
        ...textResult(`Agent aborted: ${only.agent} was stopped before it answered`, {
          mode: "single",
          results: [placeholder(only.agent, only.task)],
        }),
        isError: true,
      };
    if (isFailed(run.result))
      return {
        ...textResult(`Agent ${run.result.stopReason || "failed"}: ${outputOf(run)}`, {
          mode: "single",
          results: [slot(run, only.task)],
        }),
        isError: true,
      };
    return textResult(run.text || "(no output)", {
      mode: "single",
      results: [slot(run, only.task)],
    });
  };
}

// ---- lens_wave -----------------------------------------------------------

function unitSummary(u: Pick<LaunchUnit, "phase" | "row" | "agent">) {
  return { phase: u.phase, row: u.row, agent: u.agent };
}

/** The `lens_wave` tool's execute. */
export function lensWaveExecute(deps: LensToolDeps): Execute {
  return async function lensWave(_id, params, signal, onUpdate) {
    const p = params ?? {};
    const hasDirs = p["dirs"] !== undefined || p["dir"] !== undefined;
    const update = onUpdate as Update | undefined;

    let rows: WaveRow[];
    const launched: LaunchUnit[] = [];
    let skipped: LaunchUnit[] = [];
    const extraIgnored: string[] = [];
    if (!hasDirs) {
      if (p["extra"] !== undefined || p["skip"] !== undefined)
        return error(
          LENS_WAVE_TOOL,
          "`extra` and `skip` name rows of a task directory, so they need `dirs`",
          "Nothing was launched.",
        );
      rows = deps.wave.rows();
      if (rows.length === 0)
        return error(
          LENS_WAVE_TOOL,
          "the engine has launched no wave in this round",
          "Pass the round's task directory in `dirs`, or launch lenses yourself with `lens`.",
        );
    } else {
      const plan = planLaunch(p, { ...deps.env });
      if (!plan.ok)
        return error(
          LENS_WAVE_TOOL,
          plan.error,
          "Nothing was launched here: launch the rows with `lens`, all in this one turn.",
        );
      skipped = plan.skipped;
      rows = [];
      for (const unit of plan.units) {
        const { row, started } = deps.wave.start(deps.runner, unit, "call", signal);
        rows.push(row);
        if (started) launched.push(unit);
        else if (unit.task !== row.task) extraIgnored.push(unit.path);
      }
    }

    const joined = rows.filter((r) => !launched.some((u) => u.path === r.key));
    const summary = {
      launched: launched.map(unitSummary),
      joined: joined.map((r) => unitSummary(r.unit)),
      skipped: skipped.map(unitSummary),
      ...(extraIgnored.length > 0 ? { extra_ignored: extraIgnored } : {}),
    };
    const details = { lens_wave: summary };

    const entries: Entry[] = rows.map((r) => ({
      agent: r.unit.agent,
      task: r.task,
      run: r.result,
    }));
    const outcome = await awaitEntries(
      entries,
      rows.map((r) => r.done),
      signal,
      update,
      details,
    );
    const result = parallelResult(entries, details);
    if (outcome === "aborted") {
      const running = entries.filter((e) => e.run === undefined).length;
      return {
        ...result,
        content: [
          {
            type: "text" as const,
            text: `lens_wave was stopped with ${running} lens(es) still running.\n\n${result.content[0]!.text}`,
          },
        ],
        isError: true,
      };
    }
    return result;
  };
}

// ---- definitions ---------------------------------------------------------

const TASK_ITEM = {
  type: "object",
  properties: {
    agent: { type: "string", description: "The lens, by name (an agent of the built set)." },
    task: { type: "string", description: "Its task: the whole message it is sent." },
  },
  required: ["agent", "task"],
};

/** The `lens` tool definition. Parameters are plain JSON Schema (a TypeBox
 * schema is plain JSON Schema at runtime). */
export function lensDefinition(deps: LensToolDeps): QcrTool {
  return {
    name: LENS_TOOL,
    label: "Lens",
    description:
      "Run lens passes: one (`agent` + `task`) or several at once (`tasks`). Each pass is a read-only " +
      "reviewer that works alone and answers with its findings; it cannot launch anything itself. Use it for " +
      "the lenses you raise or add, the validator, and any pass the round's wave does not cover. The round's " +
      "planned discovery wave is collected with `lens_wave`, not launched here. Several passes belong in ONE " +
      "call so they run together. Returns each pass's result in `details.results`, in the order asked.",
    parameters: {
      type: "object",
      properties: {
        agent: { type: "string", description: "The lens, by name. With `task`." },
        task: { type: "string", description: "Its task. With `agent`." },
        tasks: {
          type: "array",
          items: TASK_ITEM,
          minItems: 1,
          maxItems: MAX_LENS_TASKS,
          description: "Several passes to run at once, each `{agent, task}`.",
        },
      },
    },
    execute: lensExecute(deps),
  };
}

/** The `lens_wave` tool definition. */
export function lensWaveDefinition(deps: LensToolDeps): QcrTool {
  return {
    name: LENS_WAVE_TOOL,
    label: "Lens wave",
    description:
      "Collect this review round's planned discovery wave. The engine launched the wave when the round " +
      "began, from the task files it wrote (state/pr-<n>-round-<k>-passes/tasks); this returns the results of " +
      "every row that is finished and waits for the rows still running. It never launches a row twice. With no " +
      "arguments it returns the wave the engine launched. With `dirs` it covers the rows of those task " +
      "directories (the round's tasks, a follow-up round's tasks-optional, the sweep's tasks-sweep) and " +
      "starts any row nobody has started yet. A row you raise to another tier belongs in `skip`, and " +
      "you run it with `lens`. Returns the same result `lens` returns for a parallel call.",
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
            "follow-up round's optional rows (…-passes/tasks-optional) and the sweep's …-passes/tasks-sweep.",
        },
        extra: {
          type: "object",
          additionalProperties: { type: "string" },
          description:
            "Text appended after the pointer of a row this call starts (prior findings assigned to that lens, a " +
            "site, a question). Key: the row number as the plan table prints it (`sweep:<row>` for a sweep row, " +
            "`optional:<row>` for an optional row), the task file name, the agent name (every row of that " +
            "agent), `plan:*` / `optional:*` / `sweep:*` (every row of that phase) or `*` (every row). A row the " +
            "engine already started keeps the text it started with.",
        },
        skip: {
          type: "array",
          items: { type: "string" },
          description:
            "Rows (same keys as `extra`) NOT to cover here because you run them yourself with `lens` at a " +
            "raised tier.",
        },
      },
    },
    execute: lensWaveExecute(deps),
  };
}

/** Both tools, in registration order. */
export function lensToolDefinitions(deps: LensToolDeps): QcrTool[] {
  return [lensDefinition(deps), lensWaveDefinition(deps)];
}
