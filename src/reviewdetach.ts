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
//
// A frozen driver (a synchronous loop stops every timer and signal handler in
// it) is beyond its own deadline's reach. `start` therefore also launches a
// watchdog, a second small process of its own group: it reads the driver's
// heartbeat (packages/pi-plugin/src/heartbeat.ts) and kills the driver's group, and the pi groups
// the beat names, once the deadline plus a grace has passed and the beat has
// stopped advancing.
//
// In the release image a run is a container of its own, started by the
// host wrapper (scripts/qcr-host.sh): `start` is a short call that only claims
// the target and writes the run (QCR_REVIEW_CONTAINER names the container the
// wrapper is about to start, QCR_RUN_ID is the id it chose); the wrapper then
// starts the driver as `review --container-run ID`. The container is the
// hard-kill backstop, so there is no watchdog and no pid: the run is alive
// while its container is up, which the wrapper tells every call it makes in
// QCR_LIVE_REVIEWS, and `stop` marks the run stopped and leaves the killing
// to the wrapper's `docker stop`, then `docker kill`.
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
import { basename, dirname, join, resolve } from "node:path";
import { stopLiveSessions } from "@quickchatai/pi-quickreview/src/engine/livesessions.js";
import {
  HEARTBEAT_FILE,
  readBeat,
  startHeartbeat,
} from "@quickchatai/pi-quickreview/src/heartbeat.js";
import {
  originRepo,
  resolveBranch,
  resolveUncommitted,
} from "@quickchatai/pi-quickreview/src/localreview.js";
import { latestLiveRound, viewRound } from "./live/read.js";
import { parsePrTarget } from "@quickchatai/pi-quickreview/src/prtarget.js";
import { parseReviewArgs } from "./reviewcli.js";
import {
  REVIEW_SCHEMA_VERSION,
  withSchemaVersion,
} from "@quickchatai/pi-quickreview/src/contract.js";

export const DETACHED_USAGE =
  "usage: qcr review start [branch | --uncommitted | --diff FILE | <PR number|URL>] [--repo OWNER/NAME] [--base REF] [--key K] [--limit USD] [--full] [--to DEST] [--out FILE] --json\n" +
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
  /** Start the detached child; it must outlive this process. A run whose
   * container is its process returns no pid, and the container's name. */
  launch: (l: {
    runId: string;
    dir: string;
    key: string;
    argv: string[];
  }) => { ok: true; pid: number | null; container?: string } | { ok: false; error: string };
  /** The names of the review containers that are up, for runs that are one
   * (null: not told, so such a run is taken to be alive). */
  liveContainers?: () => ReadonlySet<string> | null;
  /** Start the run's watchdog once the child has a pid. A failure to start it
   * leaves the run without that backstop, which is no reason to refuse it. */
  watch?: (w: { dir: string; key: string; pid: number }) => void;
}

export type RunState = "running" | "done" | "failed" | "stopped";

interface RunRecord {
  run_id: string;
  key: string;
  label: string;
  argv: string[];
  pid: number | null;
  /** The container that is this run, when it is one (the release image). */
  container?: string;
  started_at: number;
}

type Emit = (code: number, human: string, data: Record<string, unknown>) => number;

const POLL_MS = 2000;

/** The wrapper starts a run's container after the call that claimed the run
 * returns; until then the run is claimed and its container is not up. */
export const CONTAINER_START_GRACE_MS = 30_000;

/** The names of the review containers that are up, as the wrapper lists them
 * (space or newline separated) in QCR_LIVE_REVIEWS; null when it did not. */
export function liveContainersFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): ReadonlySet<string> | null {
  const v = env["QCR_LIVE_REVIEWS"];
  return v === undefined ? null : new Set(v.split(/\s+/).filter(Boolean));
}

/** Whether a run is still going, by the pid it has or by the container it is. */
export function runIsAlive(
  run: { pid: number | null; container?: string; started_at?: number },
  deps: Pick<DetachDeps, "alive" | "liveContainers"> & { now?: () => number },
): boolean {
  if (run.container !== undefined) {
    const live = deps.liveContainers?.() ?? null;
    if (live === null || live.has(run.container)) return true;
    return (
      run.started_at !== undefined &&
      deps.now !== undefined &&
      deps.now() - run.started_at < CONTAINER_START_GRACE_MS
    );
  }
  if (run.pid === null)
    // claimed, and the launch has not recorded a pid yet; a starter that died
    // in between leaves it so for good
    return (
      run.started_at === undefined ||
      deps.now === undefined ||
      deps.now() - run.started_at < CONTAINER_START_GRACE_MS
    );
  return deps.alive(run.pid);
}

type Liveness = Pick<DetachDeps, "alive" | "liveContainers" | "now">;

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
  let diff: string | undefined;
  let base: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--repo") repo = rest[++i];
    else if (a === "--base") base = rest[++i];
    else if (a === "--uncommitted") uncommitted = true;
    else if (a === "--diff") diff = rest[++i];
    else if (a === "--key" || a === "--limit" || a === "--to" || a === "--out") i++;
    else if (/^#?\d+$/.test(a) || /^https?:\/\//.test(a)) pr = a;
  }
  if (diff !== undefined) {
    // a detached child has no stdin to read the diff from
    if (diff === "-")
      return {
        ok: false,
        error:
          "a piped diff cannot run detached: run `qcr review --diff -` in the foreground, or `qcr review start --diff FILE`",
      };
    try {
      const text = readFileSync(resolve(cwd, diff));
      return {
        ok: true,
        key: `diff:${createHash("sha1").update(text).digest("hex")}`,
        label: `the diff ${diff}`,
      };
    } catch (err) {
      return {
        ok: false,
        error:
          `the diff could not be read from ${diff}: ${err instanceof Error ? err.message : String(err)}`.slice(
            0,
            300,
          ),
      };
    }
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

function observe(home: string, runId: string, deps: Liveness): Observed | null {
  // a run id from the command line never leaves the registry
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.startsWith(".")) return null;
  const dir = join(runsDir(home), runId);
  const run = readJson<RunRecord>(join(dir, "run.json"));
  if (run === null) return null;
  const exit = readJson<{ code: number }>(join(dir, "exit.json"));
  const stopped = existsSync(join(dir, "stopped.json"));
  let state: RunState;
  // A run that was stopped and unwinds records a failing exit of its own on the
  // way out (an aborted turn has no result); `stop` is what ended it, so that
  // is what it reports. A run that finished cleanly stays done.
  if (exit !== null && exit.code === 0) state = "done";
  else if (stopped) state = "stopped";
  else if (exit !== null) state = "failed";
  else if (runIsAlive(run, deps)) state = "running";
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

function allRuns(home: string, deps: Liveness): Observed[] {
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

/** What a running review is doing, from its LiveEvent log projected to
 * round-progress v2 (src/live/): the same snapshot the bot's supervisor reads. */
interface LiveProgress {
  round: number;
  parent_status: "active" | "settled";
  last_activity: string;
  updated_at: string;
  active_tool?: string;
  agents: Array<{
    agent: string;
    status: string;
    duration_ms: number;
    tool_count: number;
    current_tool?: string;
  }>;
}

interface Progress {
  lenses_started: string[];
  live?: LiveProgress;
}

/** How far a run got: the lenses its stage record names (written when the round
 * ends) and, while it runs, its live log. */
function progress(dir: string): Progress | null {
  const work = join(dir, "work");
  let dirs: string[] = [];
  try {
    dirs = readdirSync(work);
  } catch {
    return null;
  }
  const started = new Set<string>();
  let known = false;
  let live: LiveProgress | undefined;
  for (const d of dirs) {
    const stages = readJson<{ calls?: Array<{ agents?: string[]; kind?: string }> }>(
      join(work, d, "out", "stages.json"),
    );
    if (stages) {
      known = true;
      for (const c of stages.calls ?? [])
        if (c.kind === "lens") for (const a of c.agents ?? []) started.add(a);
    }
    const ref = latestLiveRound(join(work, d));
    const snapshot = ref ? viewRound(ref).snapshot : undefined;
    if (ref && snapshot) {
      known = true;
      for (const a of snapshot.agents) started.add(a.agent);
      live = {
        round: ref.round,
        parent_status: snapshot.parent_status,
        last_activity: snapshot.last_activity,
        updated_at: snapshot.updated_at,
        ...(snapshot.active_tool ? { active_tool: snapshot.active_tool } : {}),
        agents: snapshot.agents.map((a) => ({
          agent: a.agent,
          status: a.status,
          duration_ms: a.duration_ms,
          tool_count: a.tool_count,
          ...(a.current_tool ? { current_tool: a.current_tool } : {}),
        })),
      };
    }
  }
  return known ? { lenses_started: [...started], ...(live ? { live } : {}) } : null;
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
  const p = v["progress"] as Partial<Progress> | null | undefined;
  if (p?.lenses_started?.length) bits.push(`lenses started: ${p.lenses_started.join(", ")}`);
  if (p?.live) {
    const by = (s: string): string[] =>
      p.live!.agents.filter((a) => a.status === s).map((a) => a.agent);
    for (const s of ["running", "completed", "failed"]) {
      const names = by(s);
      if (names.length > 0) bits.push(`${s}: ${names.join(", ")}`);
    }
    bits.push(`now: ${p.live.last_activity}`);
  }
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
    deps.out(json ? JSON.stringify(withSchemaVersion(REVIEW_SCHEMA_VERSION, data)) : human);
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
      // a container run has no pid: the wrapper stops the container after this
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
    const parsed = parseReviewArgs(rest);
    if (!parsed.help && parsed.debugPi)
      return usage(
        "--debug-pi runs the round in your terminal: use `qcr review --debug-pi`, not start",
      );
  } catch (err) {
    return usage(err instanceof Error ? err.message : String(err));
  }

  const id = deps.identify(rest);
  if (!id.ok) return refuse([id.error]);
  const runId = deps.newId();
  if (existsSync(join(runsDir(deps.home), runId)))
    return refuse([`the run id ${runId} is already used`]);
  const lock = lockPath(deps.home, id.key);
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lock, JSON.stringify({ run_id: runId, at: deps.now() }), { flag: "wx" });
      break;
    } catch {
      const held = readJson<{ run_id: string; at?: number }>(lock);
      const o = held ? observe(deps.home, held.run_id, deps) : null;
      // a starter that has the lock and has not yet published its run
      if (o === null && held?.at !== undefined && deps.now() - held.at < CONTAINER_START_GRACE_MS)
        return refuse(["another start of this review is in progress; try again"]);
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
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({
      ...run,
      pid: l.pid,
      ...(l.container !== undefined ? { container: l.container } : {}),
    }),
  );
  try {
    if (l.pid !== null) deps.watch?.({ dir, key: id.key, pid: l.pid });
  } catch {
    // see DetachDeps.watch
  }
  return emit(0, `Review ${runId} started on ${id.label}. \`qcr review status --wait ${runId}\``, {
    ok: true,
    run_id: runId,
    state: "running",
    target: id.label,
  });
}

// ---- the child -----------------------------------------------------------------

/** What a container run was claimed with, for the driver the wrapper starts in
 * that container (`review --container-run ID`): the run's directory, its target
 * key and the review's own arguments. Null when the run is not a container run
 * of this container, or has already ended. */
export function readContainerRun(
  home: string,
  runId: string,
  container: string,
): { dir: string; key: string; argv: string[] } | null {
  if (!/^[A-Za-z0-9._-]+$/.test(runId) || runId.startsWith(".")) return null;
  const dir = join(runsDir(home), runId);
  const run = readJson<RunRecord>(join(dir, "run.json"));
  if (run === null || run.container !== container) return null;
  if (existsSync(join(dir, "exit.json")) || existsSync(join(dir, "stopped.json"))) return null;
  return { dir, key: run.key, argv: run.argv };
}

/** Launch a command as a detached process-group leader that outlives this one,
 * its output going to the run's own log. */
export function launchDetached(o: {
  command: string;
  args: string[];
  dir: string;
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** The log file in `dir`; default driver.log. */
  log?: string;
}): { ok: true; pid: number } | { ok: false; error: string } {
  try {
    const fd = openSync(join(o.dir, o.log ?? "driver.log"), "a");
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

/** The driver's SIGINT/SIGTERM (what `qcr review stop` sends).
 *
 * The sessions are in this process, so the first signal aborts them, disposes
 * them and exits 130 (`stopSessions`); the native lens tool's children share
 * the driver's group, which `stop`'s kill reaches, and the abort stops them
 * through the tool call's signal. A second signal exits at once. */
export function driverSignals(io: {
  exit: (code: number) => void;
  /** Abort, then dispose, the running SDK sessions. */
  stopSessions?: () => Promise<void>;
}): () => void {
  let seen = 0;
  return () => {
    seen++;
    if (seen === 1) {
      void (io.stopSessions?.() ?? Promise.resolve()).catch(() => {}).finally(() => io.exit(130));
      return;
    }
    io.exit(130);
  };
}

/** The detached child's body: run the review, keep what it prints, record how it
 * ended and free the target. A throw is an exit code 1 with the error as output. */
export async function runDetachedChild(o: {
  dir: string;
  key: string;
  run: (out: (line: string) => void) => Promise<number>;
  /** The process whose signals stop the run (tests inject one). */
  proc?: Pick<NodeJS.Process, "on" | "off" | "exit">;
}): Promise<void> {
  const proc = o.proc ?? process;
  const outFile = join(o.dir, "output.jsonl");
  const out = (line: string): void => appendFileSync(outFile, `${line}\n`);
  const onSignal = driverSignals({
    exit: (code) => proc.exit(code),
    stopSessions: () => stopLiveSessions(),
  });
  proc.on("SIGINT", onSignal);
  proc.on("SIGTERM", onSignal);
  const stopBeat = startHeartbeat(join(o.dir, HEARTBEAT_FILE));
  let code: number;
  try {
    code = await o.run(out);
  } catch (err) {
    out(
      JSON.stringify(
        withSchemaVersion(REVIEW_SCHEMA_VERSION, {
          ok: false,
          errors: [`the review crashed: ${String(err).slice(0, 300)}`],
        }),
      ),
    );
    code = 1;
  } finally {
    stopBeat();
    proc.off("SIGINT", onSignal);
    proc.off("SIGTERM", onSignal);
  }
  writeFileSync(join(o.dir, "exit.json"), JSON.stringify({ code }));
  // only this run's own claim: a stop frees the lock for a newer run
  const lock = lockPath(dirname(dirname(o.dir)), o.key);
  if (readJson<{ run_id?: string }>(lock)?.run_id === basename(o.dir))
    rmSync(lock, { force: true });
}

// ---- the watchdog ----------------------------------------------------------------

/** How long past a turn's deadline the driver may still be running before the
 * watchdog steps in: the in-process budget gets its own graces first. */
export const WATCHDOG_GRACE_MS = 30_000;
/** A beat older than this has stopped advancing (the driver writes every 2 s). */
export const WATCHDOG_STALE_MS = 15_000;
/** Exit code the watchdog records for a run it killed: `timeout(1)`'s. */
export const WATCHDOG_EXIT_CODE = 124;

export interface WatchdogDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  alive: (pid: number) => boolean;
  /** Signal a whole process group. */
  kill: (pgid: number, signal: NodeJS.Signals) => void;
  pollMs?: number;
  graceMs?: number;
  staleMs?: number;
}

/** Watch one detached run until it ends. Resolves "killed" after it SIGKILLs a
 * driver that is past its deadline plus the grace with a heartbeat that has
 * stopped advancing, and records that as the run's end (exit.json, an output
 * line, the target freed). Resolves "ended" when the run ends on its own. A
 * driver that is past its deadline but still beating is the in-process
 * budget's to stop, not this one's. */
export async function runWatchdog(
  w: { dir: string; key: string; pid: number },
  deps: WatchdogDeps,
): Promise<"ended" | "killed"> {
  const graceMs = deps.graceMs ?? WATCHDOG_GRACE_MS;
  const staleMs = deps.staleMs ?? WATCHDOG_STALE_MS;
  for (;;) {
    if (
      existsSync(join(w.dir, "exit.json")) ||
      existsSync(join(w.dir, "stopped.json")) ||
      !deps.alive(w.pid)
    )
      return "ended";
    const beat = readBeat(join(w.dir, HEARTBEAT_FILE));
    const now = deps.now();
    if (
      beat !== null &&
      beat.deadline_at !== null &&
      now > beat.deadline_at + graceMs &&
      now - beat.at > staleMs
    ) {
      for (const pgid of [...beat.pgids, w.pid]) {
        try {
          deps.kill(pgid, "SIGKILL");
        } catch {
          // already gone
        }
      }
      appendFileSync(
        join(w.dir, "output.jsonl"),
        `${JSON.stringify(
          withSchemaVersion(REVIEW_SCHEMA_VERSION, {
            ok: false,
            errors: [
              `the review stopped responding past its deadline and was killed by its watchdog`,
            ],
          }),
        )}\n`,
      );
      writeFileSync(join(w.dir, "exit.json"), JSON.stringify({ code: WATCHDOG_EXIT_CODE }));
      rmSync(lockPath(dirname(dirname(w.dir)), w.key), { force: true });
      return "killed";
    }
    await deps.sleep(deps.pollMs ?? 2_000);
  }
}
