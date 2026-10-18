// `qcr review start | status | stop` — detached runs for coding-CLI plugins.
//
// `start` takes the same arguments as a foreground `qcr review`, claims the
// target, launches this CLI again as a detached child that runs the review as
// JSON, and returns at once with a run id. `status [--wait] [--timeout S]`
// reports progress and, when the run is over, the findings JSON the review
// printed; `stop` cancels. Exit codes match `qcr scan`: 0 done, 1 refused
// (failed, stopped, no such run, a target already under review), 2 usage,
// 3 `status --wait` gave up at its `--timeout`.
//
// The registry lives under `home`: `runs/<id>/` holds run.json (what was
// asked), output.jsonl (what the review printed), exit.json (written by the
// child when it ends) and stopped.json (written by `stop`); `locks/<hash>.json`
// names the run that holds a target. A lock whose run is over or dead is
// stale and is replaced, so a crash never wedges a target.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { originRepo, resolveBranch, resolveUncommitted } from "./localreview.js";
import { parsePrTarget } from "./prtarget.js";
import { parseReviewArgs } from "./reviewcli.js";

export const DETACHED_USAGE =
  "usage: qcr review start [branch | --uncommitted | <PR number|URL>] [--repo OWNER/NAME] [--base REF] [--key K] [--limit USD] [--full] [--to DEST] [--out FILE] --json\n" +
  "       qcr review status [RUN_ID] [--wait [--timeout SECONDS]] --json\n" +
  "       qcr review stop [RUN_ID]";

export type Identified = { ok: true; key: string; label: string } | { ok: false; error: string };

export interface DetachDeps {
  /** The registry directory. */
  home: string;
  out: (line: string) => void;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  newId: () => string;
  alive: (pid: number) => boolean;
  /** Signal a run's whole process group. */
  kill: (pid: number, signal: NodeJS.Signals) => void;
  /** Which target a `start` is of, without running anything. */
  identify: (rest: readonly string[]) => Identified;
  /** Start the detached child; it must outlive this process. */
  launch: (l: {
    runId: string;
    dir: string;
    key: string;
    argv: string[];
  }) => { ok: true; pid: number } | { ok: false; error: string };
}

export type RunState = "running" | "done" | "failed" | "stopped";

interface RunRecord {
  run_id: string;
  key: string;
  label: string;
  argv: string[];
  pid: number | null;
  started_at: number;
}

type Emit = (code: number, human: string, data: Record<string, unknown>) => number;

const POLL_MS = 2000;

const runsDir = (home: string): string => join(home, "runs");
const lockPath = (home: string, key: string): string =>
  join(home, "locks", `${createHash("sha256").update(key).digest("hex").slice(0, 20)}.json`);

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The target a review is of, from its arguments alone (git only; no network). */
export function identifyTarget(rest: readonly string[], cwd: string): Identified {
  let pr: string | undefined;
  let repo: string | undefined;
  let uncommitted = false;
  let base: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--repo") repo = rest[++i];
    else if (a === "--base") base = rest[++i];
    else if (a === "--uncommitted") uncommitted = true;
    else if (a === "--key" || a === "--limit" || a === "--to" || a === "--out") i++;
    else if (/^#?\d+$/.test(a) || /^https?:\/\//.test(a)) pr = a;
  }
  if (pr !== undefined) {
    const p = parsePrTarget(pr, {
      cwdRepo: originRepo(cwd),
      ...(repo !== undefined ? { repo } : {}),
    });
    if (!p.ok) return { ok: false, error: p.error };
    return { ok: true, key: `pr:${p.repo}#${p.number}`, label: `PR ${p.repo}#${p.number}` };
  }
  const r = uncommitted ? resolveUncommitted(cwd) : resolveBranch(cwd, base);
  if (!r.ok) return { ok: false, error: r.error };
  const t = r.target;
  return uncommitted
    ? {
        ok: true,
        key: `uncommitted:${t.repo}@${t.branch}`,
        label: `uncommitted changes on ${t.branch}`,
      }
    : { ok: true, key: `branch:${t.repo}@${t.branch}`, label: `${t.branch} against ${t.base}` };
}

interface Observed {
  run: RunRecord;
  dir: string;
  state: RunState;
  exitCode: number | null;
  result: unknown;
}

function observe(home: string, runId: string, deps: Pick<DetachDeps, "alive">): Observed | null {
  // a run id from the command line never leaves the registry
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.startsWith(".")) return null;
  const dir = join(runsDir(home), runId);
  const run = readJson<RunRecord>(join(dir, "run.json"));
  if (run === null) return null;
  const exit = readJson<{ code: number }>(join(dir, "exit.json"));
  const stopped = existsSync(join(dir, "stopped.json"));
  let state: RunState;
  if (exit !== null) state = exit.code === 0 ? "done" : "failed";
  else if (stopped) state = "stopped";
  else if (run.pid === null || deps.alive(run.pid)) state = "running";
  else state = "failed";
  let result: unknown = null;
  try {
    const lines = readFileSync(join(dir, "output.jsonl"), "utf8").split("\n").filter(Boolean);
    for (let i = lines.length - 1; i >= 0 && result === null; i--) {
      try {
        const v = JSON.parse(lines[i]!) as unknown;
        if (v !== null && typeof v === "object") result = v;
      } catch {
        // a stray non-JSON line
      }
    }
  } catch {
    // no output yet
  }
  return { run, dir, state, exitCode: exit?.code ?? null, result };
}

function allRuns(home: string, deps: Pick<DetachDeps, "alive">): Observed[] {
  let ids: string[] = [];
  try {
    ids = readdirSync(runsDir(home));
  } catch {
    return [];
  }
  return ids
    .map((id) => observe(home, id, deps))
    .filter((o): o is Observed => o !== null)
    .sort((a, b) => a.run.started_at - b.run.started_at);
}

/** How far a run got, from the stage record its review keeps. */
function progress(dir: string): { lenses_started: string[] } | null {
  try {
    const work = join(dir, "work");
    for (const d of readdirSync(work)) {
      const stages = readJson<{ calls?: Array<{ agents?: string[]; kind?: string }> }>(
        join(work, d, "out", "stages.json"),
      );
      if (stages)
        return {
          lenses_started: [
            ...new Set(
              (stages.calls ?? []).filter((c) => c.kind === "lens").flatMap((c) => c.agents ?? []),
            ),
          ],
        };
    }
  } catch {
    // not planning yet
  }
  return null;
}

function view(o: Observed, now: number): Record<string, unknown> {
  return {
    ok: o.state === "running" || o.state === "done",
    run_id: o.run.run_id,
    state: o.state,
    target: o.run.label,
    elapsed_s: Math.max(0, Math.round((now - o.run.started_at) / 1000)),
    exit_code: o.exitCode,
    ...(o.state === "running" ? { progress: progress(o.dir) } : { result: o.result }),
    ...(o.state === "failed" && o.exitCode === null
      ? { errors: [`the review process ended without a result; see ${join(o.dir, "driver.log")}`] }
      : {}),
  };
}

function text(v: Record<string, unknown>): string {
  const bits = [`Review ${String(v["run_id"])} (${String(v["target"])}): ${String(v["state"])}`];
  const p = v["progress"] as { lenses_started?: string[] } | null | undefined;
  if (p?.lenses_started?.length) bits.push(`lenses started: ${p.lenses_started.join(", ")}`);
  const errs = v["errors"] as string[] | undefined;
  if (errs) bits.push(...errs);
  return bits.join("\n");
}

/** Run one `start | status | stop`; resolves its exit code. */
export async function runDetachedVerb(
  verb: "start" | "status" | "stop",
  rest: readonly string[],
  json: boolean,
  deps: DetachDeps,
): Promise<number> {
  const emit: Emit = (code, human, data) => {
    deps.out(json ? JSON.stringify(data) : human);
    return code;
  };
  const usage = (why: string): number => {
    const msg = `${DETACHED_USAGE}\n(${why})`;
    return emit(2, msg, { ok: false, errors: [msg] });
  };
  const refuse = (errors: string[]): number =>
    emit(1, errors.map((e) => `✗ ${e}`).join("\n"), { ok: false, errors });

  if (verb === "start") return start(rest, deps, emit, usage, refuse);

  let wait = false;
  let timeout: number | undefined;
  let id: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (verb === "status" && a === "--wait") wait = true;
    else if (verb === "status" && a === "--timeout") {
      const n = Number(rest[++i]);
      if (!Number.isFinite(n) || n <= 0)
        return usage("--timeout needs a positive number of seconds");
      timeout = n;
    } else if (!a.startsWith("-") && id === undefined) id = a;
    else return usage(`unknown argument ${a}`);
  }
  if (timeout !== undefined && !wait) return usage("--timeout needs --wait");

  const o =
    id !== undefined ? observe(deps.home, id, deps) : (allRuns(deps.home, deps).at(-1) ?? null);
  if (o === null) return refuse([id ? `no review run ${id}` : "no review run to report on"]);

  if (verb === "stop") {
    if (o.state !== "running")
      return refuse([`review ${o.run.run_id} is not running (${o.state})`]);
    writeFileSync(join(o.dir, "stopped.json"), JSON.stringify({ at: deps.now() }));
    try {
      if (o.run.pid !== null) deps.kill(o.run.pid, "SIGTERM");
    } catch {
      // already gone
    }
    rmSync(lockPath(deps.home, o.run.key), { force: true });
    return emit(0, `Stopped review ${o.run.run_id}.`, {
      ok: true,
      run_id: o.run.run_id,
      state: "stopped",
    });
  }

  let cur = o;
  const t0 = deps.now();
  while (wait && cur.state === "running") {
    if (timeout !== undefined && deps.now() - t0 >= timeout * 1000) {
      const v = view(cur, deps.now());
      return emit(3, `${text(v)}\nstill running after ${timeout}s`, { ...v, timed_out: true });
    }
    await deps.sleep(POLL_MS);
    cur = observe(deps.home, cur.run.run_id, deps) ?? cur;
  }
  const v = view(cur, deps.now());
  return emit(cur.state === "running" || cur.state === "done" ? 0 : 1, text(v), v);
}

function start(
  rest: readonly string[],
  deps: DetachDeps,
  emit: Emit,
  usage: (why: string) => number,
  refuse: (errors: string[]) => number,
): number {
  if (rest.includes("--help") || rest.includes("-h")) {
    deps.out(DETACHED_USAGE);
    return 0;
  }
  if (rest.includes("--preview"))
    return usage("a preview runs at once: use `qcr review --preview`, not start");
  // Same grammar as a foreground review; its own parser decides.
  try {
    parseReviewArgs(rest);
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }

  const id = deps.identify(rest);
  if (!id.ok) return refuse([id.error]);
  const runId = deps.newId();
  const lock = lockPath(deps.home, id.key);
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lock, JSON.stringify({ run_id: runId }), { flag: "wx" });
      break;
    } catch {
      const held = readJson<{ run_id: string }>(lock);
      const o = held ? observe(deps.home, held.run_id, deps) : null;
      if (o !== null && o.state === "running")
        return refuse([
          `a review of ${id.label} is already running (run ${o.run.run_id}): ` +
            `\`qcr review status ${o.run.run_id}\` follows it, \`qcr review stop ${o.run.run_id}\` cancels it`,
        ]);
      if (attempt > 0) return refuse(["could not claim the review target; try again"]);
      rmSync(lock, { force: true });
    }
  }
  const dir = join(runsDir(deps.home), runId);
  mkdirSync(dir, { recursive: true });
  const run: RunRecord = {
    run_id: runId,
    key: id.key,
    label: id.label,
    argv: [...rest],
    pid: null,
    started_at: deps.now(),
  };
  writeFileSync(join(dir, "run.json"), JSON.stringify(run));
  const l = deps.launch({ runId, dir, key: id.key, argv: [...rest] });
  if (!l.ok) {
    rmSync(lock, { force: true });
    rmSync(dir, { recursive: true, force: true });
    return refuse([`the review could not be started: ${l.error}`]);
  }
  writeFileSync(join(dir, "run.json"), JSON.stringify({ ...run, pid: l.pid }));
  return emit(0, `Review ${runId} started on ${id.label}. \`qcr review status --wait ${runId}\``, {
    ok: true,
    run_id: runId,
    state: "running",
    target: id.label,
  });
}

// ---- the child -----------------------------------------------------------------

/** Launch a command as a detached process-group leader that outlives this one,
 * its output going to the run's own log. */
export function launchDetached(o: {
  command: string;
  args: string[];
  dir: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}): { ok: true; pid: number } | { ok: false; error: string } {
  try {
    const fd = openSync(join(o.dir, "driver.log"), "a");
    const child = spawn(o.command, o.args, {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: o.env,
      ...(o.cwd !== undefined ? { cwd: o.cwd } : {}),
    });
    closeSync(fd);
    child.on("error", () => {});
    child.unref();
    if (child.pid === undefined) return { ok: false, error: "no process was created" };
    return { ok: true, pid: child.pid };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** The detached child's body: run the review, keep what it prints, record how it
 * ended and free the target. A throw is an exit code 1 with the error as output. */
export async function runDetachedChild(o: {
  dir: string;
  key: string;
  run: (out: (line: string) => void) => Promise<number>;
}): Promise<void> {
  const outFile = join(o.dir, "output.jsonl");
  const out = (line: string): void => appendFileSync(outFile, `${line}\n`);
  let code: number;
  try {
    code = await o.run(out);
  } catch (err) {
    out(
      JSON.stringify({ ok: false, errors: [`the review crashed: ${String(err).slice(0, 300)}`] }),
    );
    code = 1;
  }
  writeFileSync(join(o.dir, "exit.json"), JSON.stringify({ code }));
  rmSync(lockPath(dirname(dirname(o.dir)), o.key), { force: true });
}
