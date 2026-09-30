// TUI hot-reload (§2 /). The TUI watches its own dist/ and
// re-execs in place when it changes, restoring tab + selected PR + scroll from
// a small state file.
//
// Why this is safe: a failed `tsc` emits nothing, so a broken edit produces no
// mtime change and the running TUI is untouched — the reload path can only be
// entered by a build that compiled.
//
// EVERY build reloads, unconditionally — there is no busy/defer check and one
// must never come back (the owner, 2026-08-21,: "any change made is
// reload, I prefer broken in between than not knowing why nothing changed").
// The deferral existed to protect a focused surface from a re-exec, but it
// keyed on `App.isBusy()`, which counts a focused companion column as busy —
// so a reload was held exactly while the companion was editing the TUI you
// were watching, and the change silently never appeared. A reload at an
// awkward moment is visible and recoverable; a reload that never happens is
// neither. If a surface cannot survive a re-exec, fix that surface — do not
// re-add a condition here.
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  rmSync,
  watch as fsWatch,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { dirname, join } from "node:path";

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

export type WatchFn = (dir: string, opts: { recursive: boolean }, cb: () => void) => FSWatcher;

export interface ReloaderOptions {
  /** Directory whose mtime tree signals "a new build landed". */
  distDir: string;
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
  private watcher: FSWatcher | undefined;
  private debounce: NodeJS.Timeout | undefined;
  private fired = false;
  private readonly opts: Required<ReloaderOptions>;

  constructor(opts: ReloaderOptions) {
    this.opts = {
      ...opts,
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
    if (this.watcher) return;
    try {
      this.watcher = this.opts.watch(this.opts.distDir, { recursive: true }, () => this.onChange());
    } catch {
      // No dist/ (running from source, e.g. vitest or tsx) — hot-reload is a
      // convenience, never a startup requirement.
      this.watcher = undefined;
    }
  }

  stop(): void {
    this.watcher?.close();
    this.watcher = undefined;
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

/** Where THIS process writes its hot-reload snapshot. Per pid, never one
 * shared name: two TUIs on one install watch the same dist/ and reload within
 * ms of each other on one tsc emit, so a shared file let one clobber the
 * other's view and the first reader consume it. The path reaches the new
 * build through `--resume-state`, which deletes it on read. */
export function resumeStatePath(root: string, pid: number = process.pid): string {
  return join(root, "state", `tui-resume-${pid}.json`);
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

/**
 * Production re-exec: run the new build to completion in our place, then exit
 * with its code. spawnSync keeps the terminal on one process at a time.
 *
 * `teardown` is the LAST code this generation runs. `app.quit()` only resolves
 * a promise, so `App.teardown()` is a microtask — and the `spawnSync` below
 * blocks the stack before any microtask can run, which means this process
 * freezes with its listeners still registered and its event loop stopped for
 * good. Anything that must happen before that freeze has to happen
 * SYNCHRONOUSLY inside `teardown`, and that specifically includes killing
 * in-flight ssh children: their timeouts live on the loop that is about to
 * stop (see `killInFlightSsh` in remote.ts).
 */
export function realReexec(stateFile: string, teardown?: () => void): void {
  teardown?.();
  const argv = reexecArgv(process.argv.slice(1), stateFile);
  const res = spawnSync(process.execPath, argv, { stdio: "inherit" });
  process.exit(res.status ?? 0);
}
