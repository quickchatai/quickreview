// `qcr review start | status | stop` (src/reviewdetach.ts): detached runs for
// plugins. Time, pids, the launcher and the review itself are injected; one
// test really spawns a detached node stub to show the run outlives its starter.
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identifyTarget,
  launchDetached,
  runDetachedChild,
  runDetachedVerb,
  type DetachDeps,
} from "../src/reviewdetach.js";

const tmp = mkdtempSync(join(tmpdir(), "review-detached-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface Harness {
  deps: DetachDeps;
  lines: string[];
  launched: Array<{ runId: string; argv: string[] }>;
  killed: Array<{ pid: number; sig: string }>;
  clock: { t: number };
  live: Set<number>;
}

let n = 0;
function harness(over: Partial<DetachDeps> = {}): Harness {
  const home = join(tmp, `home${n++}`);
  const lines: string[] = [];
  const launched: Harness["launched"] = [];
  const killed: Harness["killed"] = [];
  const clock = { t: 1_000_000 };
  const live = new Set<number>();
  let pid = 4000;
  let ids = 0;
  const deps: DetachDeps = {
    home,
    out: (l) => lines.push(l),
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
    },
    newId: () => {
      clock.t += 1000;
      return `run${++ids}`;
    },
    alive: (p) => live.has(p),
    kill: (p, sig) => {
      killed.push({ pid: p, sig });
      live.delete(p);
    },
    identify: (rest) =>
      rest.includes("bad")
        ? { ok: false, error: "not a git repository" }
        : {
            ok: true,
            key: `branch:o/r@${rest.includes("other") ? "other" : "feature"}`,
            label: "feature",
          },
    launch: (l) => {
      launched.push({ runId: l.runId, argv: l.argv });
      pid += 1;
      live.add(pid);
      return { ok: true, pid };
    },
    ...over,
  };
  return { deps, lines, launched, killed, clock, live };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = (h: Harness): Record<string, any> => JSON.parse(h.lines[h.lines.length - 1]!);

/** Pretend the child ran to its end. */
function finish(h: Harness, runId: string, code: number, result: unknown): void {
  const dir = join(h.deps.home, "runs", runId);
  writeFileSync(join(dir, "output.jsonl"), `${JSON.stringify(result)}\n`);
  writeFileSync(join(dir, "exit.json"), JSON.stringify({ code }));
  h.live.clear();
}

describe("start", () => {
  it("returns at once with a run id and launches the review as json", async () => {
    const h = harness();
    expect(await runDetachedVerb("start", ["--base", "main"], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ ok: true, run_id: "run1", state: "running" });
    expect(h.launched).toHaveLength(1);
    expect(h.launched[0]!.argv).toEqual(["--base", "main"]);
  });

  it("refuses a second concurrent review of the same target, clearly", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.lines.length = 0;
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(1);
    const j = json(h);
    expect(j.ok).toBe(false);
    expect(j.errors[0]).toMatch(/already running.*run1/);
    expect(h.launched).toHaveLength(1);
  });

  it("allows a different target, and the same target once the first has finished", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("start", ["--base", "other"], true, h.deps)).toBe(0);
    finish(h, "run1", 0, { ok: true });
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
  });

  it("replaces a lock whose run died", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.live.clear();
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
  });

  it("exits 2 on bad review arguments and on --preview, 1 when the target cannot be resolved", async () => {
    const h = harness();
    expect(await runDetachedVerb("start", ["--nonsense"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("start", ["--preview"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("start", ["--base", "bad"], true, h.deps)).toBe(1);
    expect(h.launched).toHaveLength(0);
  });

  it("is refused (1) when the launch fails, and leaves no lock", async () => {
    const h = harness({ launch: () => ({ ok: false, error: "spawn ENOENT" }) });
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(1);
    const ok = harness();
    expect(await runDetachedVerb("start", [], true, ok.deps)).toBe(0);
  });
});

describe("status", () => {
  it("reports a running review without waiting (exit 0)", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({ ok: true, run_id: "run1", state: "running" });
  });

  it("returns the findings JSON of a done run (exit 0)", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    finish(h, "run1", 0, { ok: true, findings: { high: [{ title: "x" }] } });
    expect(await runDetachedVerb("status", ["--wait"], true, h.deps)).toBe(0);
    expect(json(h)).toMatchObject({
      state: "done",
      exit_code: 0,
      result: { ok: true, findings: { high: [{ title: "x" }] } },
    });
  });

  it("--wait polls until the run finishes", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    let polls = 0;
    h.deps.sleep = async (ms) => {
      h.clock.t += ms;
      if (++polls === 3) finish(h, "run1", 0, { ok: true });
    };
    expect(await runDetachedVerb("status", ["--wait"], true, h.deps)).toBe(0);
    expect(polls).toBe(3);
  });

  it("exits 1 for a run the review refused or failed, still carrying its json", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    finish(h, "run1", 1, { ok: false, errors: ["declined"] });
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(1);
    expect(json(h)).toMatchObject({
      state: "failed",
      exit_code: 1,
      result: { errors: ["declined"] },
    });
  });

  it("exits 1 for a run that died without a result", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    h.live.clear();
    expect(await runDetachedVerb("status", ["--wait"], true, h.deps)).toBe(1);
    expect(json(h).state).toBe("failed");
  });

  it("exits 3 when --wait times out", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("status", ["--wait", "--timeout", "5"], true, h.deps)).toBe(3);
    expect(json(h)).toMatchObject({ timed_out: true, state: "running" });
  });

  it("exits 2 on usage errors and 1 when there is no such run", async () => {
    const h = harness();
    expect(await runDetachedVerb("status", ["--timeout", "5"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("status", ["--wait", "--timeout", "x"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("status", ["--what"], true, h.deps)).toBe(2);
    expect(await runDetachedVerb("status", [], true, h.deps)).toBe(1);
    expect(await runDetachedVerb("status", ["nope"], true, h.deps)).toBe(1);
  });

  it("selects a run by id", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    await runDetachedVerb("start", ["--base", "other"], true, h.deps);
    await runDetachedVerb("status", ["run1"], true, h.deps);
    expect(json(h).run_id).toBe("run1");
    await runDetachedVerb("status", [], true, h.deps);
    expect(json(h).run_id).toBe("run2");
  });
});

describe("stop", () => {
  it("cancels a running review: kills its group, frees the target (exit 0)", async () => {
    const h = harness();
    await runDetachedVerb("start", [], true, h.deps);
    expect(await runDetachedVerb("stop", [], true, h.deps)).toBe(0);
    expect(h.killed).toEqual([{ pid: 4001, sig: "SIGTERM" }]);
    await runDetachedVerb("status", [], true, h.deps);
    expect(json(h).state).toBe("stopped");
    expect(await runDetachedVerb("start", [], true, h.deps)).toBe(0);
  });

  it("is refused (1) when nothing is running, and usage (2) on a stray flag", async () => {
    const h = harness();
    expect(await runDetachedVerb("stop", [], true, h.deps)).toBe(1);
    await runDetachedVerb("start", [], true, h.deps);
    finish(h, "run1", 0, { ok: true });
    expect(await runDetachedVerb("stop", [], true, h.deps)).toBe(1);
    expect(await runDetachedVerb("stop", ["--wait"], true, h.deps)).toBe(2);
  });
});

describe("the real child", () => {
  it("a launched node process outlives the call that started it, and status --wait returns its findings", async () => {
    const home = join(tmp, "real");
    const stub = join(tmp, "stub.mjs");
    const dist = join(process.cwd(), "dist", "src", "reviewdetach.js");
    writeFileSync(
      stub,
      `import { runDetachedChild } from ${JSON.stringify(dist)};
await runDetachedChild({ dir: process.argv[2], key: process.argv[3], run: async (out) => {
  await new Promise((r) => setTimeout(r, 400));
  out(JSON.stringify({ ok: true, findings: { high: [{ title: "from the child" }] } }));
  return 0;
} });
`,
    );
    const lines: string[] = [];
    const deps: DetachDeps = {
      home,
      out: (l) => lines.push(l),
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      newId: () => "real1",
      alive: (p) => {
        try {
          process.kill(p, 0);
          return true;
        } catch {
          return false;
        }
      },
      kill: (p, s) => process.kill(-p, s),
      identify: () => ({ ok: true, key: "branch:o/r@x", label: "x" }),
      launch: (l) =>
        launchDetached({
          command: process.execPath,
          args: [stub, l.dir, l.key],
          dir: l.dir,
          env: process.env,
        }),
    };
    const t0 = Date.now();
    expect(await runDetachedVerb("start", [], true, deps)).toBe(0);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(await runDetachedVerb("status", ["--wait", "--timeout", "20"], true, deps)).toBe(0);
    const j = JSON.parse(lines[lines.length - 1]!);
    expect(j.state).toBe("done");
    expect(j.result.findings.high[0].title).toBe("from the child");
  });
});

describe("identifyTarget", () => {
  it("keys a branch and the uncommitted tree apart, and a PR by repo and number", () => {
    const repo = join(tmp, "repo");
    mkdirSync(repo);
    const g = (...a: string[]): void => {
      execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@e.x", ...a], { cwd: repo });
    };
    g("init", "-q", "-b", "main");
    writeFileSync(join(repo, "a"), "1\n");
    g("add", "-A");
    g("commit", "-q", "-m", "base");
    g("checkout", "-q", "-b", "feature");
    writeFileSync(join(repo, "a"), "2\n");
    g("commit", "-q", "-am", "change");
    writeFileSync(join(repo, "a"), "3\n");
    const b = identifyTarget([], repo);
    const u = identifyTarget(["--uncommitted"], repo);
    const p = identifyTarget(["12", "--repo", "o/r"], repo);
    expect(b.ok && u.ok && p.ok).toBe(true);
    if (b.ok && u.ok && p.ok) {
      expect(new Set([b.key, u.key, p.key]).size).toBe(3);
      expect(p.key).toBe("pr:o/r#12");
      expect(identifyTarget([], repo)).toEqual(b);
    }
    expect(identifyTarget([], tmp).ok).toBe(false);
  });
});

describe("runDetachedChild", () => {
  it("records exit code 1 and the error when the run throws", async () => {
    const dir = join(tmp, "child", "runs", "c1");
    mkdirSync(dir, { recursive: true });
    await runDetachedChild({
      dir,
      key: "k",
      run: async () => {
        throw new Error("boom");
      },
    });
    expect(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")).code).toBe(1);
    expect(readFileSync(join(dir, "output.jsonl"), "utf8")).toContain("boom");
  });
});
