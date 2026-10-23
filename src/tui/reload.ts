// TUI hot-reload. The TUI re-execs in place when a whole build has landed,
// restoring tab + selected PR + scroll from a small state file. Two signals
// say so, and nothing else does:
//   - the app's dist/, watched recursively. `tsc -b` builds the review core
//     (packages/pi-plugin) first and the app last, so the app's dist/ changes
//     only once every project compiled;
//   - the build stamp (BUILD_STAMP, written by scripts/build-stamp.mjs), for a
//     core-only change that leaves the app's output alone. Every build route
//     writes it only after a whole pass succeeded.
// The core's own dist/ is NOT watched. `noEmitOnError` holds per project, so
// a core edit that breaks the app still rewrites packages/pi-plugin/dist, and
// even a clean build writes it seconds before the app's: a watch there would
// re-exec onto new core code beside old app code.
//
// Why this is safe: a failed build touches neither signal (the app does not
// emit on error, and the stamp follows only a clean pass), so a broken edit
// leaves the running TUI untouched — the reload path can only be entered by a
// build that compiled, all of it.
//
// Every build reloads, unconditionally — there is no busy/defer check and one
// must never be added (the hot-reload decision, docs/tui.md). A busy check
// keyed on `App.isBusy()` would hold a reload exactly while the companion
// column is focused editing the TUI, and the change would silently never
// appear. A reload at an awkward moment is visible and recoverable; a reload
// that never happens is neither. If a surface cannot survive a re-exec, fix
// that surface — do not add a condition here.
//
// The chain stays two processes deep. Node cannot replace its own image, so a
// re-exec runs the new build as a child and waits for it; done at every
// reload, each generation would sit frozen inside `spawnSync` under the next,
// still holding whatever its teardown had not released. So the first process
// to reload becomes the supervisor: it runs each new build as its child, in a
// loop, and a child that wants a reload exits with `RELOAD_EXIT_CODE` after
// its teardown — the supervisor runs the next build beside it, never under
// it. Depth: the supervisor plus the live TUI, whatever the number of
// reloads. There is no condition on when a reload fires; only on how it is
// executed.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  watch as fsWatch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface ReloadState {
  tab: string;
  /** Selected PR number, when the board had one. */
  pr?: number;
  eventsScroll: number;
  eventsFocus: boolean;
  /** Expanded companion width, borders included. */
  sidebarWidth?: number;
  saved_at: string;
}

export type WatchFn = (
  dir: string,
  opts: { recursive: boolean },
  cb: (event: string, filename: string | null) => void,
) => FSWatcher;

/** The build stamp, relative to the checkout: written after a whole build
 * succeeded (scripts/build-stamp.mjs names the same path). */
export const BUILD_STAMP = "state/build-complete";

export interface ReloaderOptions {
  /** The app's build output, whose mtime tree signals "a new build landed". */
  distDir: string;
  /** The build stamp's absolute path: a change to it signals the same, for a
   * core-only build that leaves `distDir` alone. Its directory is watched,
   * not recursively, for that one name; a missing directory is skipped, as a
   * missing `distDir` is. */
  buildStamp?: string;
  /** Where the pre-re-exec snapshot is written. */
  stateFile: string;
  /** Snapshot of what must survive the re-exec. */
  snapshot: () => ReloadState;
  /** Perform the re-exec; receives the path the state was persisted to. */
  reexec: (stateFile: string) => void;
  debounceMs?: number;
  watch?: WatchFn;
  writeState?: (path: string, body: string) => void;
  now?: () => Date;
}

const DEBOUNCE_MS = 400;

/** Watches dist/ and re-execs the process when a new build lands. */
export class HotReloader {
  private watchers: FSWatcher[] = [];
  private debounce: NodeJS.Timeout | undefined;
  private fired = false;
  private readonly opts: Required<ReloaderOptions>;

  constructor(opts: ReloaderOptions) {
    this.opts = {
      ...opts,
      buildStamp: opts.buildStamp ?? "",
      debounceMs: opts.debounceMs ?? DEBOUNCE_MS,
      watch: opts.watch ?? fsWatch,
      writeState:
        opts.writeState ??
        ((path, body) => {
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, body);
        }),
      now: opts.now ?? (() => new Date()),
    };
  }

  start(): void {
    if (this.watchers.length > 0) return;
    this.watchOne(this.opts.distDir, true, () => true);
    const stamp = this.opts.buildStamp;
    if (stamp) this.watchOne(dirname(stamp), false, (name) => name === basename(stamp));
  }

  private watchOne(dir: string, recursive: boolean, counts: (name: string | null) => boolean) {
    try {
      this.watchers.push(
        this.opts.watch(dir, { recursive }, (_event, name) => {
          if (counts(name)) this.onChange();
        }),
      );
    } catch {
      // No dist/ (running from source, e.g. vitest or tsx) — hot-reload is a
      // convenience, never a startup requirement.
    }
  }

  stop(): void {
    for (const w of this.watchers) w.close();
    this.watchers = [];
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = undefined;
  }

  private onChange(): void {
    if (this.fired) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      this.attempt();
    }, this.opts.debounceMs);
  }

  private attempt(): void {
    if (this.fired) return;
    this.fired = true;
    this.stop();
    const state: ReloadState = { ...this.opts.snapshot(), saved_at: this.opts.now().toISOString() };
    this.opts.writeState(this.opts.stateFile, `${JSON.stringify(state, null, 2)}\n`);
    this.opts.reexec(this.opts.stateFile);
  }
}

/** The snapshot file name of one TUI process. */
function resumeStateName(pid: number): string {
  return `tui-resume-${pid}.json`;
}

/** Where this process writes its hot-reload snapshot. Per pid, never one
 * shared name: two TUIs on one install watch the same dist/ and reload within
 * ms of each other on one tsc emit, so a shared file would let one clobber
 * the other's view and the first reader consume it. The path reaches the new
 * build through `--resume-state`, which deletes it on read. */
export function resumeStatePath(root: string, pid: number = process.pid): string {
  return join(root, "state", resumeStateName(pid));
}

/** The snapshot path of process `pid`, beside `file` — how a supervisor finds
 * the snapshot its child wrote (the child wrote it with `resumeStatePath`
 * under the same root, so the directory is the supervisor's own). */
export function resumeStatePathBeside(file: string, pid: number): string {
  return join(dirname(file), resumeStateName(pid));
}

/** `--resume-state <path>` out of an argv, plus the argv with it removed. */
export function parseResumeArg(argv: string[]): { stateFile?: string; rest: string[] } {
  const i = argv.indexOf("--resume-state");
  if (i < 0 || argv[i + 1] === undefined)
    return { rest: argv.filter((a) => a !== "--resume-state") };
  return { stateFile: argv[i + 1], rest: [...argv.slice(0, i), ...argv.slice(i + 2)] };
}

/** Reads and consumes a resume file. Unreadable/garbled → undefined (a bad
 * snapshot must never keep the TUI from starting). */
export function readResumeState(path: string, remove = true): ReloadState | undefined {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
  if (remove) {
    try {
      rmSync(path);
    } catch {
      /* best effort */
    }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<ReloadState>;
    return {
      tab: typeof parsed.tab === "string" ? parsed.tab : "board",
      pr: typeof parsed.pr === "number" ? parsed.pr : undefined,
      eventsScroll: typeof parsed.eventsScroll === "number" ? parsed.eventsScroll : 0,
      eventsFocus: Boolean(parsed.eventsFocus),
      ...(typeof parsed.sidebarWidth === "number" ? { sidebarWidth: parsed.sidebarWidth } : {}),
      saved_at: typeof parsed.saved_at === "string" ? parsed.saved_at : "",
    };
  } catch {
    return undefined;
  }
}

/** The argv a re-exec should run: same entry point, same flags, one
 * `--resume-state <file>` (never duplicated across successive reloads). */
export function reexecArgv(argv: string[], stateFile: string): string[] {
  const [entry, ...args] = argv;
  const { rest } = parseResumeArg(args);
  return [entry!, ...rest, "--resume-state", stateFile];
}

/** The exit code a supervised TUI uses to say "run the new build". 75 is
 * EX_TEMPFAIL, "try again" — distinct from every exit the TUI
 * makes on its own (0 quit, 1 crash, 2 no terminal, 130/143 on a signal). */
export const RELOAD_EXIT_CODE = 75;

/** Set on every TUI a supervisor runs: the supervisor's pid. A TUI follows the
 * exit protocol only when that pid is its own parent, so the variable leaking
 * into something the TUI starts (a shell on the real terminal, the companion)
 * can never make an unsupervised TUI exit instead of reloading. */
export const SUPERVISOR_ENV = "QCR_TUI_SUPERVISOR_PID";

/** What the re-exec touches — real process calls in production, fakes in
 * tests. `argv` is `process.argv.slice(1)`: the entry point, then the flags. */
export interface ReexecIo {
  argv: string[];
  env: NodeJS.ProcessEnv;
  pid: number;
  ppid: number;
  /** Run the build to completion with the terminal inherited. */
  spawn: (argv: string[], env: NodeJS.ProcessEnv) => { status: number | null; pid?: number };
  exit: (code: number) => void;
}

function processIo(): ReexecIo {
  return {
    argv: process.argv.slice(1),
    env: process.env,
    pid: process.pid,
    ppid: process.ppid,
    spawn: (argv, env) => {
      const res = spawnSync(process.execPath, argv, { stdio: "inherit", env });
      return { status: res.status, pid: res.pid };
    },
    exit: (code) => process.exit(code),
  };
}

/** Is this TUI the child of a reload supervisor (and so should EXIT to
 * reload)? Only when the supervisor named in the env is its parent. */
export function isSupervised(io: Pick<ReexecIo, "env" | "ppid">): boolean {
  const raw = io.env[SUPERVISOR_ENV];
  if (raw === undefined || raw.trim() === "") return false;
  return Number(raw) === io.ppid;
}

/**
 * The supervisor's loop: run the build, and while it exits asking for a
 * reload, run the next one with the snapshot that child wrote. Returns the
 * last child's exit code (a signal death counts as 0).
 * One process deep beneath the supervisor, however many reloads.
 */
export function superviseReloads(firstStateFile: string, io: ReexecIo): number {
  const env = { ...io.env, [SUPERVISOR_ENV]: String(io.pid) };
  let stateFile = firstStateFile;
  for (;;) {
    const res = io.spawn(reexecArgv(io.argv, stateFile), env);
    if (res.status !== RELOAD_EXIT_CODE || res.pid === undefined) return res.status ?? 0;
    stateFile = resumeStatePathBeside(stateFile, res.pid);
  }
}

/**
 * Production re-exec. A TUI under a supervisor exits with `RELOAD_EXIT_CODE`
 * and the supervisor runs the new build; the first TUI to reload becomes the
 * supervisor, running every later build as its child (see the header), then
 * exits with the last one's code. spawnSync keeps the terminal on one process
 * at a time.
 *
 * `teardown` is the last code this generation runs. `app.quit()` only resolves
 * a promise, so `App.teardown()` is a microtask — and the `spawnSync` below
 * blocks the stack before any microtask can run, which means this process
 * freezes with its listeners still registered and its event loop stopped for
 * good. Anything that must happen before that freeze has to happen
 * synchronously inside `teardown`, and that specifically includes killing
 * in-flight ssh children: their timeouts live on the loop that is about to
 * stop (see `killInFlightSsh` in remote.ts).
 */
export function realReexec(
  stateFile: string,
  teardown?: () => void,
  io: ReexecIo = processIo(),
): void {
  teardown?.();
  if (isSupervised(io)) {
    // The snapshot is already on disk (HotReloader wrote it before calling
    // us); the supervisor finds it by our pid.
    io.exit(RELOAD_EXIT_CODE);
    return;
  }
  io.exit(superviseReloads(stateFile, io));
}
