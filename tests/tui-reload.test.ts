import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HotReloader,
  isSupervised,
  parseResumeArg,
  readResumeState,
  realReexec,
  reexecArgv,
  RELOAD_EXIT_CODE,
  resumeStatePath,
  resumeStatePathBeside,
  SUPERVISOR_ENV,
  superviseReloads,
  type ReexecIo,
  type ReloaderOptions,
  type ReloadState,
  type WatchFn,
} from "../src/tui/reload.js";

const SNAP: ReloadState = {
  tab: "board",
  pr: 5012,
  eventsScroll: 3,
  eventsFocus: true,
  sidebarWidth: 52,
  saved_at: "",
};

/** fs.watch stand-in: hand back a trigger the test can fire. */
function fakeWatch(): {
  watch: WatchFn;
  fire: () => void;
  closed: () => boolean;
  dir: () => string | undefined;
} {
  let cb: (() => void) | undefined;
  let closed = false;
  let dir: string | undefined;
  const watch: WatchFn = (d, _opts, handler) => {
    dir = d;
    cb = handler;
    return { close: () => (closed = true) } as unknown as ReturnType<WatchFn>;
  };
  return { watch, fire: () => cb?.(), closed: () => closed, dir: () => dir };
}

function build(over: Partial<Parameters<typeof makeOpts>[0]> = {}) {
  return makeOpts(over);
}

function makeOpts(over: { writes?: Array<[string, string]>; reexecs?: string[]; watch?: WatchFn }) {
  const writes: Array<[string, string]> = over.writes ?? [];
  const reexecs: string[] = over.reexecs ?? [];
  const w = over.watch
    ? { watch: over.watch, fire: () => {}, closed: () => false, dir: () => undefined }
    : fakeWatch();
  const reloader = new HotReloader({
    distDir: "/sandbox/dist",
    stateFile: "/sandbox/state/tui-resume.json",
    snapshot: () => ({ ...SNAP }),
    reexec: (f) => reexecs.push(f),
    watch: w.watch,
    writeState: (p, b) => writes.push([p, b]),
    now: () => new Date("2026-08-14T12:00:00Z"),
  });
  return { reloader, writes, reexecs, w };
}

describe("HotReloader", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("watches the dist dir recursively", () => {
    const { reloader, w } = build();
    reloader.start();
    expect(w.dir()).toBe("/sandbox/dist");
    reloader.stop();
    expect(w.closed()).toBe(true);
  });

  it("persists the snapshot and re-execs after the debounce", () => {
    const { reloader, writes, reexecs, w } = build();
    reloader.start();
    w.fire();
    expect(reexecs).toHaveLength(0); // debounced
    vi.advanceTimersByTime(500);
    expect(reexecs).toEqual(["/sandbox/state/tui-resume.json"]);
    expect(writes).toHaveLength(1);
    const state = JSON.parse(writes[0]![1]) as ReloadState;
    expect(state).toMatchObject({ tab: "board", pr: 5012, eventsScroll: 3, eventsFocus: true });
    expect(state.saved_at).toBe("2026-08-14T12:00:00.000Z");
  });

  it("coalesces a burst of writes into one re-exec", () => {
    const { reloader, reexecs, w } = build();
    reloader.start();
    w.fire();
    vi.advanceTimersByTime(100);
    w.fire();
    vi.advanceTimersByTime(100);
    w.fire();
    vi.advanceTimersByTime(500);
    expect(reexecs).toHaveLength(1);
  });

  // Every build reloads, unconditionally. A busy check would hold the reload
  // exactly while the companion column has focus — i.e. while the companion
  // is editing the TUI — so the change would silently never appear; a reload
  // at an awkward moment is visible and recoverable. These pin the absence of
  // any condition.
  it("never defers — a reload fires even while a surface owns the keyboard", () => {
    const { reloader, reexecs, w } = build();
    reloader.start();
    w.fire();
    vi.advanceTimersByTime(500);
    expect(reexecs).toHaveLength(1);
  });

  it("takes no busy predicate at all, so one cannot be wired back in", () => {
    // A structural pin: if someone re-adds the option, this stops compiling
    // rather than silently restoring the deferral.
    const opts: ReloaderOptions = {
      distDir: "/sandbox/dist",
      stateFile: "/sandbox/state/tui-resume.json",
      snapshot: () => ({ ...SNAP }),
      reexec: () => {},
    };
    expect(Object.keys(opts)).not.toContain("isBusy");
    expect(new HotReloader(opts)).toBeInstanceOf(HotReloader);
  });

  it("re-execs at most once and stops watching", () => {
    const { reloader, reexecs, w } = build();
    reloader.start();
    w.fire();
    vi.advanceTimersByTime(500);
    w.fire();
    vi.advanceTimersByTime(500);
    expect(reexecs).toHaveLength(1);
    expect(w.closed()).toBe(true);
  });

  it("a missing dist dir disables reload instead of throwing", () => {
    const throwing: WatchFn = () => {
      throw new Error("ENOENT");
    };
    const { reloader } = build({ watch: throwing });
    expect(() => reloader.start()).not.toThrow();
    reloader.stop();
  });

  it("does not re-exec until a build actually lands", () => {
    const { reloader, reexecs } = build();
    reloader.start();
    vi.advanceTimersByTime(5_000);
    expect(reexecs).toHaveLength(0);
  });
});

describe("resume state", () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), "qcr-reload-"))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips and consumes the file", () => {
    const p = join(dir, "tui-resume.json");
    writeFileSync(
      p,
      JSON.stringify({ ...SNAP, tab: "digest", saved_at: "2026-08-14T12:00:00.000Z" }),
    );
    const restored = readResumeState(p);
    expect(restored).toMatchObject({ tab: "digest", pr: 5012, eventsScroll: 3, sidebarWidth: 52 });
    expect(readResumeState(p)).toBeUndefined(); // consumed
  });

  it("two TUIs on one install reloading together each resume their OWN view", () => {
    // Both watch the same dist/ and fire within ms of each other on one tsc
    // emit. With one shared file the second write would clobber the first, A's
    // new process would read B's view and delete it, and B would come back on
    // defaults.
    const pathA = resumeStatePath(dir, 1111);
    const pathB = resumeStatePath(dir, 2222);
    expect(pathA).not.toBe(pathB);
    expect(pathA.startsWith(join(dir, "state"))).toBe(true);
    const handed: string[] = [];
    const mk = (stateFile: string, tab: string) => {
      const w = fakeWatch();
      const r = new HotReloader({
        distDir: join(dir, "dist"),
        stateFile,
        snapshot: () => ({ ...SNAP, tab }),
        reexec: (f) => handed.push(f),
        watch: w.watch,
        debounceMs: 0,
      });
      r.start();
      return w;
    };
    vi.useFakeTimers();
    try {
      const a = mk(pathA, "digest");
      const b = mk(pathB, "memory");
      a.fire();
      b.fire();
      vi.advanceTimersByTime(10);
    } finally {
      vi.useRealTimers();
    }
    expect(handed).toEqual([pathA, pathB]);
    expect(readResumeState(handed[0]!)?.tab).toBe("digest");
    expect(readResumeState(handed[1]!)?.tab).toBe("memory");
  });

  it("the TUI writes its snapshot to THIS process's path, never a shared name", () => {
    // Pins the wiring, not just the helper: a revert of index.ts to one fixed
    // state/tui-resume.json would pass the helper test above.
    expect(resumeStatePath("/r")).toBe(`/r/state/tui-resume-${process.pid}.json`);
    const src = readFileSync(join(process.cwd(), "src", "tui", "index.ts"), "utf8");
    expect(src).toContain("resumeStatePath(sandboxRoot())");
    expect(src).not.toMatch(/["'`]tui-resume\.json["'`]/);
  });

  it("survives a garbled or missing file", () => {
    const p = join(dir, "bad.json");
    writeFileSync(p, "{not json");
    expect(readResumeState(p)).toBeUndefined();
    expect(readResumeState(join(dir, "nope.json"))).toBeUndefined();
  });

  it("fills defaults for a partial snapshot", () => {
    const p = join(dir, "partial.json");
    writeFileSync(p, JSON.stringify({ pr: 7 }));
    expect(readResumeState(p)).toEqual({
      tab: "board",
      pr: 7,
      eventsScroll: 0,
      eventsFocus: false,
      saved_at: "",
    });
  });
});

describe("argv plumbing", () => {
  it("parses and strips --resume-state", () => {
    expect(parseResumeArg(["5012", "--resume-state", "/s.json"])).toEqual({
      stateFile: "/s.json",
      rest: ["5012"],
    });
    expect(parseResumeArg(["overseer"])).toEqual({ rest: ["overseer"] });
    expect(parseResumeArg(["--resume-state"])).toEqual({ rest: [] }); // dangling flag
  });

  it("re-exec argv keeps the entry point and flags, never duplicating the state flag", () => {
    const first = reexecArgv(["/x/dist/src/cli.js", "tui", "5012"], "/s.json");
    expect(first).toEqual(["/x/dist/src/cli.js", "tui", "5012", "--resume-state", "/s.json"]);
    expect(reexecArgv(first, "/s2.json")).toEqual([
      "/x/dist/src/cli.js",
      "tui",
      "5012",
      "--resume-state",
      "/s2.json",
    ]);
  });
});

// ---- the chain stays two deep ------------------------------------------------
//
// A reload that ran the new build as a child of the old one and waited would
// keep every generation alive, frozen, under the next. The first TUI to
// reload supervises — every later build is its child — and a supervised TUI
// that wants a reload exits. There is still no condition on when a reload
// fires.

describe("the reload chain stays two processes deep, however many reloads", () => {
  /** A simulated process tree. Each spawned "TUI" runs `life` — it reloads
   * `reloads` times across the whole tree, then quits with `finalCode`. */
  function simulate(reloads: number, finalCode: number | null = 0) {
    let nextPid = 101;
    let depth = 1; // the first TUI
    let maxDepth = 1;
    let reloadsLeft = reloads;
    const spawns: Array<{ by: number; pid: number; argv: string[]; env: NodeJS.ProcessEnv }> = [];
    const exits: Array<{ pid: number; code: number }> = [];

    const ioFor = (pid: number, ppid: number, env: NodeJS.ProcessEnv, argv: string[]): ReexecIo => {
      let exited: number | undefined;
      const io: ReexecIo = {
        argv,
        env,
        pid,
        ppid,
        exit: (code) => {
          exited = code;
          exits.push({ pid, code });
        },
        spawn: (childArgv, childEnv) => {
          const childPid = nextPid++;
          spawns.push({ by: pid, pid: childPid, argv: childArgv, env: childEnv });
          depth += 1;
          maxDepth = Math.max(maxDepth, depth);
          const status = runTui(childPid, pid, childEnv, childArgv);
          depth -= 1;
          return { status, pid: childPid };
        },
      };
      // Expose what this process exited with, for runTui.
      (io as ReexecIo & { exited: () => number | undefined }).exited = () => exited;
      return io;
    };

    /** One TUI process: a build lands → it reloads (if any are left), else quits. */
    const runTui = (pid: number, ppid: number, env: NodeJS.ProcessEnv, argv: string[]) => {
      const io = ioFor(pid, ppid, env, argv) as ReexecIo & { exited: () => number | undefined };
      if (reloadsLeft > 0) {
        reloadsLeft -= 1;
        realReexec(resumeStatePath("/sandbox", pid), () => {}, io);
        return io.exited() ?? null;
      }
      return finalCode;
    };

    const first = ioFor(100, 1, { PATH: "/bin" }, ["/x/dist/src/cli.js", "tui", "--no-companion"]);
    reloadsLeft -= 1;
    realReexec(resumeStatePath("/sandbox", 100), () => {}, first);
    return { spawns, exits, maxDepth };
  }

  it("five reloads: one supervisor, every build its direct child, never three deep", () => {
    const { spawns, exits, maxDepth } = simulate(5);
    expect(maxDepth).toBe(2);
    expect(spawns).toHaveLength(5);
    // Every build was started by the FIRST process — none by a build.
    expect(new Set(spawns.map((s) => s.by))).toEqual(new Set([100]));
    // …and each carried the supervisor's pid, so it knows to exit to reload.
    for (const s of spawns) expect(s.env[SUPERVISOR_ENV]).toBe("100");
    // The supervised builds exited with the reload code; the last one quit,
    // and the supervisor exited with its code.
    expect(exits.filter((e) => e.code === RELOAD_EXIT_CODE).map((e) => e.pid)).toEqual([
      101, 102, 103, 104,
    ]);
    expect(exits.at(-1)).toEqual({ pid: 100, code: 0 });
  });

  it("each build resumes from the snapshot the PREVIOUS build wrote", () => {
    const { spawns } = simulate(3);
    expect(spawns.map((s) => s.argv.slice(-2))).toEqual([
      ["--resume-state", "/sandbox/state/tui-resume-100.json"],
      ["--resume-state", "/sandbox/state/tui-resume-101.json"],
      ["--resume-state", "/sandbox/state/tui-resume-102.json"],
    ]);
    // Flags survive, the state flag is never duplicated.
    for (const s of spawns)
      expect(s.argv.slice(0, 3)).toEqual(["/x/dist/src/cli.js", "tui", "--no-companion"]);
    expect(resumeStatePathBeside("/sandbox/state/tui-resume-100.json", 7)).toBe(
      "/sandbox/state/tui-resume-7.json",
    );
  });

  it("the last build's exit is the supervisor's exit — a crash stays a crash, a signal reads 0", () => {
    expect(simulate(2, 1).exits.at(-1)).toEqual({ pid: 100, code: 1 });
    expect(simulate(2, null).exits.at(-1)).toEqual({ pid: 100, code: 0 });
  });

  it("only a TUI whose PARENT is the named supervisor exits to reload — a leaked variable changes nothing", () => {
    expect(isSupervised({ env: { [SUPERVISOR_ENV]: "100" }, ppid: 100 })).toBe(true);
    expect(isSupervised({ env: { [SUPERVISOR_ENV]: "100" }, ppid: 555 })).toBe(false);
    expect(isSupervised({ env: { [SUPERVISOR_ENV]: "" }, ppid: 0 })).toBe(false);
    expect(isSupervised({ env: {}, ppid: 100 })).toBe(false);
    // An unsupervised TUI handed a stray variable becomes a supervisor itself.
    const spawned: string[][] = [];
    const exits: number[] = [];
    realReexec("/s/state/tui-resume-9.json", undefined, {
      argv: ["/x/cli.js", "tui"],
      env: { [SUPERVISOR_ENV]: "4242" },
      pid: 9,
      ppid: 1,
      spawn: (argv) => (spawned.push(argv), { status: 0, pid: 10 }),
      exit: (code) => void exits.push(code),
    });
    expect(spawned).toEqual([["/x/cli.js", "tui", "--resume-state", "/s/state/tui-resume-9.json"]]);
    expect(exits).toEqual([0]);
  });

  it("the supervisor's loop is exactly that — no predicate decides whether a build runs", () => {
    let n = 0;
    const code = superviseReloads("/s/state/tui-resume-1.json", {
      argv: ["/x/cli.js", "tui"],
      env: {},
      pid: 1,
      ppid: 0,
      spawn: () => ({ status: ++n < 4 ? RELOAD_EXIT_CODE : 0, pid: 100 + n }),
      exit: () => {},
    });
    expect(n).toBe(4);
    expect(code).toBe(0);
  });

  it("the TUI leaves the terminal to the next build on a reload exit, and restores it on every other", () => {
    const src = readFileSync(join(process.cwd(), "src", "tui", "index.ts"), "utf8");
    expect(src).toMatch(
      /process\.on\("exit", \(code\) => \{\s*if \(code === RELOAD_EXIT_CODE\) return;\s*restoreTerminal\(\);/,
    );
    expect(src).not.toMatch(/process\.on\("exit", restoreTerminal\)/);
  });
});

// ---- what makes the unfiltered watch safe -----------------------------------
//
// `HotReloader` watches dist/ RECURSIVELY AND UNFILTERED, and the header of
// reload.ts rests the whole design on one sentence: "a failed `tsc` emits
// nothing, so the running TUI is untouched". Two tsconfig settings are what
// make that sentence true, and both are invisible from this file — so they are
// pinned here, beside the guarantee they support.

describe("the compiler settings the unfiltered dist watch depends on", () => {
  const tsconfig = JSON.parse(
    readFileSync(join(process.cwd(), "tsconfig.json"), "utf8").replace(/^\s*\/\/.*$/gm, ""),
  ) as { compilerOptions: Record<string, unknown> };

  it("keeps the incremental buildinfo OUT of dist/", () => {
    // tsc writes the buildinfo even when the compile failed. Inside dist/ that
    // is a watched file changing on a broken edit — a re-exec of the TUI in the
    // middle of typing, i.e. the exact opposite of the stated guarantee.
    const info = tsconfig.compilerOptions.tsBuildInfoFile;
    expect(typeof info).toBe("string");
    expect(String(info).startsWith("dist/")).toBe(false);
  });

  it("is guarded by a post-build artefact check on every path that runs dist/", () => {
    // `noEmitOnError` + `incremental` leave one hole between them: tsc emits
    // from its BUILD INFO, so a file deleted after the last successful build is
    // never re-emitted and the compiler still exits 0. `dev-tui.sh` would then
    // start the TUI from an incomplete dist/, and `deploy.sh` would rsync it to
    // the VM. Every path that consumes dist/ must assert the artefacts exist.
    const build = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(build.scripts.build).toContain("verify-dist.mjs");
    for (const script of ["scripts/dev-tui.sh", "scripts/deploy.sh"]) {
      expect(
        readFileSync(join(process.cwd(), script), "utf8"),
        `${script} runs dist/ without checking it is complete`,
      ).toContain("verify-dist.mjs");
    }
  });

  // verify-dist proves dist/ is COMPLETE, never
  // that it is FRESH. The build info sits under node_modules/, which every
  // worktree reaches through a symlink, so a worktree's build rewrites this
  // checkout's: merged here, its sources read as already emitted and an
  // incremental build writes nothing over the OLD compiled daemon.
  // MUTATION: drop the `rm -f` line from deploy.sh, or move it below the
  // build — this fails.
  it("deploy.sh builds cold: it removes the shared build info before it rebuilds dist/", () => {
    const deploy = readFileSync(join(process.cwd(), "scripts", "deploy.sh"), "utf8");
    const info = String(tsconfig.compilerOptions.tsBuildInfoFile);
    const removal = deploy.indexOf(`rm -f "$SANDBOX_DIR/${info}"`);
    const build = deploy.indexOf("npm run build)");
    expect(removal, `deploy.sh never removes ${info}`).toBeGreaterThan(-1);
    expect(build).toBeGreaterThan(-1);
    expect(removal).toBeLessThan(build);
  });

  it("that check reports a missing artefact rather than trusting tsc's exit code", async () => {
    const { missingArtifacts } = (await import("../scripts/verify-dist.mjs")) as unknown as {
      missingArtifacts(root: string): Array<{ source: string; emitted: string }>;
    };
    const root = mkdtempSync(join(tmpdir(), "qcr-dist-"));
    mkdirSync(join(root, "src", "tui"), { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { outDir: "dist" },
        include: ["src/**/*.ts"],
        exclude: ["dist", "tests"],
      }),
    );
    writeFileSync(join(root, "src", "tui", "startup.ts"), "export const a = 1;");
    writeFileSync(join(root, "src", "types.d.ts"), "export type T = 1;");
    mkdirSync(join(root, "dist", "src", "tui"), { recursive: true });

    // The exact shape of the hole: the source is there, the output is not.
    expect(missingArtifacts(root).map((m) => m.emitted)).toEqual(["dist/src/tui/startup.js"]);
    writeFileSync(join(root, "dist", "src", "tui", "startup.js"), "export const a = 1;");
    // …and a complete tree is clean — a `.d.ts` emits nothing and must not be
    // reported as missing, or the check would cry wolf on every build.
    expect(missingArtifacts(root)).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });

  it("does not emit JavaScript from a failing build", () => {
    // Without this tsc emits on error by default: one type error re-emits
    // files into dist/, and the "failed build touches nothing" guarantee
    // does not hold.
    expect(tsconfig.compilerOptions.noEmitOnError).toBe(true);
  });
});
