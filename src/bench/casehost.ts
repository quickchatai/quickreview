// One host process per bench case. On `[engine] runtime = "sdk"` a case's pi
// session lives inside the process that runs it, so the process is the blast
// radius: a crash, an out-of-memory kill or a frozen event loop would take every
// case that shares it. The bench therefore starts a child `node` process for each
// review case, and for each case of the defect judge's pool, running the very
// same command for that one case (`--case-host`). The parent keeps the pool, the
// login sync and the scoring; the child hosts the SDK runtime for its case and
// exits. A child that dies, is killed or outlives its wall clock costs that case,
// recorded as a failure, and the others carry on.
//
// A host also ends with its parent. The parent holds the write end of a pipe on
// the host's stdin; when the parent dies by any means, SIGKILL and the OOM killer
// included, the pipe closes and the host takes its own process group down
// (`exitWithParent`). Without that, a plain `bench.sh review --concurrency N`
// whose parent was killed would leave its hosts and their lens children running.
//
// The proc runtime is unchanged: its pi is already a child per session.
import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { safeId, type BenchCase } from "./aacr.js";
import {
  clearAttemptFiles,
  recordHostFailure,
  type CaseSummary,
  type RunFingerprint,
} from "./runner.js";

/** The exit status of a case host that stopped because the login would expire
 * inside the case (the same code `bench auth` uses). */
export const CASE_HOST_AUTH_STOP = 3;

/** Grace between the SIGTERM a deadline sends and the SIGKILL that follows. */
const KILL_GRACE_MS = 10_000;

/** How a case host ended. */
export interface HostEnd {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** The host outlived its wall clock and was killed. */
  timedOut: boolean;
  /** The process could not be started. */
  spawnError?: string;
}

/** The flags a pool owns: a host is told its one case, its serial pool and its
 * runtime afresh, whatever the parent was given. */
const POOL_FLAGS = ["--only", "--concurrency", "--phase", "--runtime"] as const;

/**
 * The argv of the host for case `id`: the parent's own command line with the
 * pool's flags replaced. `argv` is the parent's `[command, ...flags]`; `phase`
 * is the review's `--phase case` (never touch run.json, resume semantics), absent
 * for the judge.
 */
export function caseHostArgv(
  argv: readonly string[],
  id: string,
  o: { phase?: "case" } = {},
): string[] {
  const [cmd = "", ...rest] = argv;
  const kept: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if ((POOL_FLAGS as readonly string[]).includes(a)) {
      i++;
      continue;
    }
    if (a === "--case-host") continue;
    kept.push(a);
  }
  return [
    cmd,
    ...kept,
    "--only",
    id,
    "--concurrency",
    "1",
    "--runtime",
    "sdk",
    ...(o.phase ? ["--phase", o.phase] : []),
    "--case-host",
  ];
}

/**
 * Called by a case host at its start: when its stdin, the pipe the pool holds the
 * other end of, ends, the pool is gone, and the host stops with whatever it
 * started (it leads its process group). A stdin that is a terminal (a person
 * running a host by hand) is left alone. `orphaned` is the stop, replaceable in a test.
 */
export function exitWithParent(
  stdin: Readable & { isTTY?: boolean } = process.stdin,
  orphaned: () => void = () => {
    killGroup(process.pid, "SIGKILL");
    process.exit(1);
  },
): void {
  if (stdin.isTTY) return;
  stdin.once("end", orphaned);
  stdin.once("error", orphaned);
  stdin.resume();
}

/** Every host process alive, so the parent can take them down with it. */
const live = new Set<number>();

function killGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    // The host leads its own process group: a lens child it started goes too.
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // already gone
    }
  }
}

/** Stops every case host still running (the parent is ending). */
export function killCaseHosts(signal: NodeJS.Signals = "SIGKILL"): void {
  for (const pid of live) killGroup(pid, signal);
}

export interface CaseHostOptions {
  /** The script the host runs: the bench cli itself. */
  entry: string;
  /** Node's own flags, passed on. */
  execArgv?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The host's wall clock, from its start. */
  timeoutMs: number;
  /** Replaces `process.execPath`. */
  node?: string;
}

/** Runs the host for one case to its end. Never rejects. The host's stdout and
 * stderr are the parent's own, so its log lines read as the parent's. */
export function runCaseHost(argv: readonly string[], o: CaseHostOptions): Promise<HostEnd> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(o.node ?? process.execPath, [...(o.execArgv ?? []), o.entry, ...argv], {
        env: o.env ?? process.env,
        // stdin is the pipe a host watches to learn its parent has died.
        stdio: ["pipe", "inherit", "inherit"],
        detached: true,
      });
    } catch (e) {
      resolve({ code: null, signal: null, timedOut: false, spawnError: String(e) });
      return;
    }
    const pid = child.pid;
    if (pid !== undefined) live.add(pid);
    let timedOut = false;
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      if (pid !== undefined) killGroup(pid, "SIGTERM");
      hard = setTimeout(() => {
        if (pid !== undefined) killGroup(pid, "SIGKILL");
      }, KILL_GRACE_MS);
    }, o.timeoutMs);
    let settled = false;
    const end = (e: HostEnd): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      if (pid !== undefined) {
        live.delete(pid);
        // Whatever the host left running in its group goes with it.
        killGroup(pid, "SIGKILL");
      }
      resolve(e);
    };
    child.on("error", (e) => end({ code: null, signal: null, timedOut, spawnError: e.message }));
    child.on("close", (code, signal) => end({ code, signal, timedOut }));
  });
}

/** A host's end in words, for a case's recorded error and the log. */
export function describeHostEnd(e: HostEnd, timeoutMs: number): string {
  if (e.spawnError !== undefined) return `the case host could not be started: ${e.spawnError}`;
  if (e.timedOut)
    return `the case host outlived its wall clock (${Math.round(timeoutMs / 60_000)} min) and was killed`;
  if (e.signal !== null) return `the case host was killed by ${e.signal}`;
  return `the case host exited ${String(e.code)} without recording the case`;
}

// ---- the two pools' cases -----------------------------------------------------

/** What a pool needs to start hosts. */
export interface HostPool extends Omit<CaseHostOptions, "timeoutMs"> {
  /** The parent's `[command, ...flags]`. */
  argv: readonly string[];
  log: (line: string) => void;
}

/** Wall clock past the case's own budget that a host gets for what surrounds the
 * model turn: the tree, the dependency sources, the render and the teardown. */
const HOST_SLACK_MS = 20 * 60_000;

/**
 * Review one case in its own host process and return its summary. The host
 * writes the case dir and `case-summary.json` as an in-process review would; a
 * host that leaves no summary (it died, was killed, or outlived `timeoutMs` plus
 * the slack) is recorded as a failed case with an empty result file, its event
 * stream kept. The case's earlier attempt is cleared first, so nothing found
 * there afterwards is not this attempt's.
 */
export async function reviewCaseHosted(
  c: BenchCase,
  pool: HostPool,
  o: { root: string; outDir: string; fingerprint: RunFingerprint; timeoutMs: number },
): Promise<CaseSummary> {
  const caseDir = join(o.outDir, "cases", safeId(c.instance_id));
  mkdirSync(caseDir, { recursive: true });
  clearAttemptFiles(caseDir);
  const summaryFile = join(caseDir, "case-summary.json");
  rmSync(summaryFile, { force: true });
  const started = Date.now();
  const wall = o.timeoutMs + HOST_SLACK_MS;
  const end = await runCaseHost(caseHostArgv(pool.argv, c.instance_id, { phase: "case" }), {
    ...pool,
    timeoutMs: wall,
  });
  if (existsSync(summaryFile)) return JSON.parse(readFileSync(summaryFile, "utf8")) as CaseSummary;
  const why = describeHostEnd(end, wall);
  pool.log(`review: ${c.instance_id} FAILED — ${why}`);
  // What the dead host left on the wt volume.
  const safe = safeId(c.instance_id);
  rmSync(join(o.root, "wt", safe), { recursive: true, force: true });
  rmSync(join(o.root, "wt", `${safe}.tmp`), { recursive: true, force: true });
  return recordHostFailure(
    o.outDir,
    c,
    why,
    o.fingerprint,
    Math.round((Date.now() - started) / 1000),
  );
}

/** How a judged case ended in its host. */
export type HostedJudge = "judged" | "unjudged" | "auth-stop";

/**
 * Judge one case in its own host process. `judged` is the host's clean exit; its
 * own refusals (a case it could not prepare) and a host that died, was killed or
 * outlived `rounds` turns plus the slack are `unjudged`, the latter said in the
 * log. A host that stopped on an expiring login says so by its exit status.
 */
export async function judgeCaseHosted(
  c: BenchCase,
  pool: HostPool,
  o: { root: string; rounds: number; timeoutMs: number },
): Promise<HostedJudge> {
  const wall = Math.max(1, o.rounds) * o.timeoutMs + HOST_SLACK_MS;
  const end = await runCaseHost(caseHostArgv(pool.argv, c.instance_id), {
    ...pool,
    timeoutMs: wall,
  });
  if (end.spawnError === undefined && !end.timedOut && end.signal === null) {
    if (end.code === 0) return "judged";
    if (end.code === CASE_HOST_AUTH_STOP) return "auth-stop";
    // Exit 1 is the host's own report of a case it could not judge, already logged.
    if (end.code === 1) return "unjudged";
  }
  pool.log(`defect-judge: ${c.instance_id} — ${describeHostEnd(end, wall)}`);
  const safe = safeId(c.instance_id);
  rmSync(join(o.root, "wt", `judge-${safe}`), { recursive: true, force: true });
  rmSync(join(o.root, "wt", `judge-${safe}.tmp`), { recursive: true, force: true });
  return "unjudged";
}
