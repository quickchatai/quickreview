// Planning a launch from a round's task files: which directories a lens
// launch may read (confined to the round's own pass dirs), which files are
// discovery rows, and how `skip` / `extra` apply. Pure over the filesystem it
// reads. Lifted from the retired extensions/subagents.ts, whose `launch_plan`
// tool it planned for; `lens_wave` (tool.ts) is its successor.
import { readdirSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

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
  /** "plan" for the round's tasks dir, "optional" for a follow-up round's
   * optional rows, "sweep" for the sweep's. */
  phase: "plan" | "sweep" | "optional";
  /** 1-based row, as the plan tables print it. */
  row: number;
  agent: string;
  file: string;
  path: string;
  task: string;
}

export type LaunchPlan =
  { ok: true; units: LaunchUnit[]; skipped: LaunchUnit[] } | { ok: false; error: string };

export function realDir(path: string): string | undefined {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The extra sanctioned dirs from the environment, each resolved; one that
 * does not exist sanctions nothing. */
export function sanctionedExtras(env: Record<string, string | undefined>): Set<string> {
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
export function resolveTaskDir(
  input: string,
  realRoot: string,
  extras: ReadonlySet<string>,
  pr: string | undefined,
):
  | { dir: string; phase: "plan" | "sweep" | "optional"; passes: string | undefined }
  | { error: string } {
  const real = realDir(resolve(realRoot, input));
  if (!real) return { error: `${input}: no such directory` };
  // Resolved too: on the legacy VM `<sandbox>/state` was a SYMLINK to the state volume
  // (its entrypoint), and the plain Docker path still links it, so a resolved task dir lives under its target.
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
  // `tasks-optional` — a follow-up round's optional rows.
  const phaseOf = (n: string): "plan" | "sweep" | "optional" =>
    n === "tasks-sweep" ? "sweep" : n === "tasks-optional" ? "optional" : "plan";
  if (
    (name === "tasks" || name === "tasks-sweep" || name === "tasks-optional") &&
    dirname(dirname(real)) === state &&
    ownPasses(basename(dirname(real)))
  )
    return { dir: real, phase: phaseOf(name), passes: dirname(real) };
  if (extras.has(real)) return { dir: real, phase: phaseOf(name), passes: undefined };
  return {
    error: `${input}: not a round's task directory (only state/pr-<n>-round-<k>-passes/tasks, …/tasks-sweep or …/tasks-optional)`,
  };
}

/** The discovery task files of one dir, in row order (= the daemon's launch
 * order). Regular files only: a symlink is never followed. */
export function listTaskFiles(dir: string): Array<{ row: number; agent: string; file: string }> {
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
 * without `.md`), its row (`3`, or `sweep:3` / `optional:3` outside the
 * plan), its agent, its phase's wildcard (`plan:*` / `optional:*` /
 * `sweep:*`) and `*`. */
export function unitKeys(u: Pick<LaunchUnit, "phase" | "row" | "file" | "agent">): string[] {
  const row = u.phase === "plan" ? String(u.row) : `${u.phase}:${u.row}`;
  return [u.file, u.file.replace(/\.md$/, ""), row, u.agent, `${u.phase}:*`, "*"];
}

export function stringList(value: unknown): string[] | undefined {
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
      return {
        ok: false,
        error: "`dirs` must name the round's task directory (one to three paths)",
      };
    if (dirs.length > 3)
      return {
        ok: false,
        error: "at most three dirs: the round's tasks, its tasks-optional and its tasks-sweep",
      };
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

    const resolved: Array<{
      dir: string;
      phase: "plan" | "sweep" | "optional";
      passes: string | undefined;
    }> = [];
    for (const d of dirs) {
      const r = resolveTaskDir(d, realRoot, extras, env.QCR_PR?.trim() || undefined);
      if ("error" in r) return { ok: false, error: r.error };
      if (resolved.some((x) => x.dir === r.dir)) continue;
      if (resolved.some((x) => x.phase === r.phase))
        return { ok: false, error: `two ${r.phase} task directories in one launch` };
      if (resolved.some((x) => x.passes !== r.passes))
        return { ok: false, error: "the task directories belong to different rounds" };
      resolved.push(r);
    }
    // Plan rows first, then the optional rows, then the sweep's — the daemon's
    // launch order within each.
    const rank = { plan: 0, optional: 1, sweep: 2 } as const;
    resolved.sort((a, b) => rank[a.phase] - rank[b.phase]);

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
