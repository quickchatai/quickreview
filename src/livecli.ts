// `qcr live [RUN_ID | DIR] [--lens ID] [--round N] [--follow] [--json]` - read a
// review's LiveEvent log (src/live/) as a transcript: what the main session
// said and did, tool by tool, and with `--lens` one lens session's.
//
// RUN_ID is a detached run (`qcr review start`), DIR a run directory or a round
// directory (`.../state/live/<key>/r<n>`); with neither, the newest run. With
// `--follow` it keeps reading what is appended until the session settles or the
// run is over. The log is read by byte offset, so a follow never re-reads, and
// a line a writer is still finishing is left for the next poll.
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  LIVE_MAIN_FILE,
  lensLogName,
  readLiveEvents,
  type LiveEvent,
} from "@quickchatai/pi-quickreview/src/live/events.js";
import {
  latestLiveRound,
  lensLogIds,
  listLiveRounds,
  type LiveRoundRef,
} from "@quickchatai/pi-quickreview/src/live/read.js";

export const LIVE_USAGE =
  "usage: qcr live [RUN_ID | DIR] [--lens ID] [--round N] [--follow] [--json]";

export interface LiveCliDeps {
  /** The detached-run registry (`<state home>/review/detached`). */
  home: string;
  out: (line: string) => void;
  sleep: (ms: number) => Promise<void>;
  /** Whether a pid is alive (to stop following a run that died). */
  alive: (pid: number) => boolean;
  /** The review containers that are up, for runs that are one (null: not told). */
  liveContainers?: () => ReadonlySet<string> | null;
}

const POLL_MS = 500;

const clock = (at: string): string => at.slice(11, 19);

const oneLine = (s: string, max = 160): string => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** Per-render memory: a message whose text already streamed as deltas does not
 * print again at its end. */
export interface RenderState {
  streamed: boolean;
}

export function newRenderState(): RenderState {
  return { streamed: false };
}

/** One event as transcript lines. */
export function renderLiveEvent(e: LiveEvent, state: RenderState): string[] {
  const t = clock(e.at);
  switch (e.type) {
    case "session_start":
      return [
        e.stream === "lens"
          ? `${t}  lens ${e.agent ?? ""} ${e.lens_id ?? ""} (${e.session}, round ${e.round})`.replace(
              /\s+/g,
              " ",
            )
          : `${t}  session ${e.session} (${e.key}, round ${e.round})`,
      ];
    case "agent_start":
      return [`${t}  agent started`];
    case "agent_end":
      return e.will_retry ? [`${t}  agent turn ended, retrying`] : [];
    case "agent_settled":
      return [`${t}  agent settled${e.aborted ? " (aborted)" : ""}`];
    case "message_start":
      state.streamed = false;
      return e.role === "user" && e.text ? [`${t}  > ${oneLine(e.text)}`] : [];
    case "message_delta":
      state.streamed = state.streamed || Boolean(e.text);
      return e.text ? e.text.split("\n").map((l) => `    ${l}`) : [];
    case "message_end": {
      const lines: string[] = [];
      if (!state.streamed && e.text) lines.push(...e.text.split("\n").map((l) => `    ${l}`));
      const bits = [
        e.tool_calls?.length ? `calls ${e.tool_calls.join(", ")}` : "",
        e.stop_reason ?? "",
        e.usage ? `$${e.usage.cost_usd.toFixed(4)}` : "",
        e.error ? `error: ${oneLine(e.error, 100)}` : "",
      ].filter(Boolean);
      if (bits.length > 0) lines.push(`${t}  assistant ${bits.join(" · ")}`);
      state.streamed = false;
      return lines;
    }
    case "tool_start": {
      const what = e.executions?.length
        ? e.executions.map((x) => x.agent).join(", ")
        : (e.preview ?? "");
      return [`${t}  ${e.parent ? "  " : ""}tool ${e.tool}${what ? ` ${what}` : ""}`];
    }
    case "tool_update":
      return e.results.map(
        (r) =>
          `${t}    ${r.agent ?? `child ${r.slot}`} ${r.progress?.status ?? "…"}` +
          ((r.progress?.tool_count ?? r.native?.tool_count)
            ? ` (${r.progress?.tool_count ?? r.native?.tool_count} tools)`
            : "") +
          ((r.progress?.last_message ?? r.native?.last_text)
            ? ` ${oneLine((r.progress?.last_message ?? r.native?.last_text)!, 80)}`
            : ""),
      );
    case "tool_end": {
      const bits = [
        e.is_error ? "failed" : "done",
        e.duration_ms !== undefined ? `${(e.duration_ms / 1000).toFixed(1)}s` : "",
        e.cost_usd !== undefined ? `$${e.cost_usd.toFixed(4)}` : "",
      ].filter(Boolean);
      return [`${t}  ${e.parent ? "  " : ""}tool ${e.tool} ${bits.join(" · ")}`];
    }
    case "queue_update":
      return e.steering.length + e.follow_up.length > 0
        ? [`${t}  queued: ${e.steering.length} steer, ${e.follow_up.length} follow-up`]
        : [];
    case "compaction_start":
      return [`${t}  compacting (${e.reason})`];
    case "compaction_end":
      return [`${t}  compaction ${e.aborted ? "aborted" : "done"}${e.error ? `: ${e.error}` : ""}`];
    case "retry":
      return [
        e.phase === "start"
          ? `${t}  retry ${e.attempt}${e.error ? `: ${oneLine(e.error, 100)}` : ""}`
          : `${t}  retry ${e.success ? "succeeded" : "gave up"}`,
      ];
    default:
      return [];
  }
}

// ---- finding the log --------------------------------------------------------------

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

interface Target {
  ref: LiveRoundRef;
  /** Set when the target is a registry run: where its exit lives. */
  runDir?: string;
  pid: number | null;
  /** The container the run is, when it is one. */
  container?: string;
}

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

/** The run roots under a detached run directory: `work/<run>/`. */
function runRoots(runDir: string): string[] {
  const work = join(runDir, "work");
  try {
    return readdirSync(work)
      .map((d) => join(work, d))
      .filter(isDir);
  } catch {
    return [];
  }
}

function newestRun(home: string): string | undefined {
  const runs = join(home, "runs");
  try {
    return readdirSync(runs)
      .filter((d) => existsSync(join(runs, d, "run.json")))
      .sort()
      .at(-1);
  } catch {
    return undefined;
  }
}

function resolveTarget(
  arg: string | undefined,
  round: number | undefined,
  deps: LiveCliDeps,
): Target | string {
  let roots: string[];
  let runDir: string | undefined;
  let pid: number | null = null;
  let container: string | undefined;
  const id = arg ?? newestRun(deps.home);
  const run =
    id !== undefined && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)
      ? readJson<{ pid: number | null; container?: string }>(
          join(deps.home, "runs", id, "run.json"),
        )
      : null;
  if (run !== null && id !== undefined) {
    runDir = join(deps.home, "runs", id);
    pid = run.pid;
    container = run.container;
    roots = runRoots(runDir);
  } else if (arg !== undefined && existsSync(join(arg, LIVE_MAIN_FILE))) {
    // a round directory: .../state/live/<key>/r<n>
    const m = /^(.*)[/\\]([^/\\]+)[/\\]r(\d+)$/.exec(resolve(arg));
    if (!m) return `${arg} is not a round log directory (state/live/<key>/r<n>)`;
    if (round !== undefined && round !== Number(m[3]))
      return `${arg} is round ${m[3]}, not round ${round}`;
    return { ref: { dir: resolve(arg), key: m[2]!, round: Number(m[3]) }, pid };
  } else if (arg !== undefined && isDir(arg)) {
    roots = [resolve(arg)];
  } else {
    return arg === undefined ? "no review run to read" : `no review run ${arg}`;
  }
  const pick =
    round !== undefined
      ? roots
          .flatMap((r) => listLiveRounds(r))
          .filter((r) => r.round === round)
          .at(-1)
      : roots
          .map((r) => latestLiveRound(r))
          .filter((r): r is LiveRoundRef => r !== undefined)
          .at(-1);
  if (pick === undefined)
    return round !== undefined
      ? `no round ${round} log yet`
      : "no live log yet: the review has not started its session";
  return {
    ref: pick,
    ...(runDir !== undefined ? { runDir } : {}),
    pid,
    ...(container !== undefined ? { container } : {}),
  };
}

// ---- the verb -----------------------------------------------------------------------

/** Run `qcr live`; resolves its exit code (0 read, 1 nothing to read, 2 usage). */
export async function runLive(
  rest: readonly string[],
  json: boolean,
  deps: LiveCliDeps,
): Promise<number> {
  let arg: string | undefined;
  let lens: string | undefined;
  let round: number | undefined;
  let follow = false;
  // a usage error found before a later --json is still reported as JSON
  const wantsJson = json || rest.includes("--json");
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === "--follow" || a === "-f") follow = true;
    else if (a === "--json") json = true;
    else if (a === "--lens") {
      lens = rest[++i];
      if (lens === undefined) return usage(deps, "--lens needs a lens id", wantsJson);
    } else if (a === "--round") {
      const n = Number(rest[++i]);
      if (!Number.isInteger(n) || n < 1)
        return usage(deps, "--round needs a round number", wantsJson);
      round = n;
    } else if (!a.startsWith("-") && arg === undefined) arg = a;
    else return usage(deps, `unknown argument ${a}`, wantsJson);
  }
  if (lens === "" || (lens !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(lens)))
    return usage(deps, "--lens needs a lens id", wantsJson);

  const target = resolveTarget(arg, round, deps);
  if (typeof target === "string") {
    deps.out(json ? JSON.stringify({ ok: false, errors: [target] }) : `✗ ${target}`);
    return 1;
  }
  const file = join(target.ref.dir, lens !== undefined ? lensLogName(lens) : LIVE_MAIN_FILE);
  if (lens !== undefined && !existsSync(file)) {
    const known = lensLogIds(target.ref.dir);
    deps.out(
      json
        ? JSON.stringify({ ok: false, errors: [`no lens log ${lens}`], lenses: known })
        : `✗ no lens log ${lens}; this round has: ${known.join(", ") || "none"}`,
    );
    return 1;
  }

  const state = newRenderState();
  let offset = 0;
  let announced = false;
  for (;;) {
    const read = readLiveEvents(file, offset);
    offset = read.nextOffset;
    for (const e of read.events) {
      if (json) deps.out(JSON.stringify(e));
      else for (const line of renderLiveEvent(e, state)) deps.out(line);
    }
    if (!announced && !json) {
      announced = true;
      const lenses = lensLogIds(target.ref.dir);
      if (lens === undefined && lenses.length > 0)
        deps.out(`(lens logs: ${lenses.join(", ")}; read one with --lens ID)`);
    }
    const settled = read.events.some((e) => e.type === "agent_settled");
    if (!follow || (settled && lens === undefined)) return 0;
    if (lens !== undefined && settled) return 0;
    // A run that ended, or whose driver died, writes nothing more.
    if (target.runDir !== undefined && ended(target.runDir, target, deps)) {
      const last = readLiveEvents(file, offset);
      if (last.events.length === 0) return 0;
      continue;
    }
    await deps.sleep(POLL_MS);
  }
}

function ended(runDir: string, run: Pick<Target, "pid" | "container">, deps: LiveCliDeps): boolean {
  if (existsSync(join(runDir, "exit.json")) || existsSync(join(runDir, "stopped.json")))
    return true;
  // a container run's liveness is the wrapper's list of the containers that are up
  if (run.container !== undefined) {
    const live = deps.liveContainers?.() ?? null;
    return live !== null && !live.has(run.container);
  }
  return run.pid !== null && !deps.alive(run.pid);
}

function usage(deps: LiveCliDeps, why: string, json: boolean): number {
  deps.out(
    json
      ? JSON.stringify({ ok: false, errors: [why], usage: LIVE_USAGE })
      : `${LIVE_USAGE}\n(${why})`,
  );
  return 2;
}
