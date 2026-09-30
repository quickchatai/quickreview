import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HotReloader,
  parseResumeArg,
  readResumeState,
  reexecArgv,
  resumeStatePath,
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

  //. The reloader used to defer on an `isBusy()` predicate, which the
  // TUI wired to App.isBusy() — true while the companion column has focus. So
  // a build landed, the reload was held, and the change you had just asked the
  // companion for silently never appeared. The owner: "any change made is
  // reload, I prefer broken in between than not knowing why nothing changed."
  // There is no condition left to assert, so these pin the ABSENCE of one.
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
    // emit. With one shared file the second write clobbered the first, A's
    // new process read B's view and deleted it, and B came back on defaults.
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

// ---- what makes the unfiltered watch safe --------------------------
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
    // Without this tsc emits on error by default: one type error re-emitted 40
    // files into dist/ when measured it, so the "failed build touches
    // nothing" guarantee was never actually true.
    expect(tsconfig.compilerOptions.noEmitOnError).toBe(true);
  });
});
