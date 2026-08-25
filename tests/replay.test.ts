// the regression replay and its `qcr regression` entrypoint.
//
// The whole mechanism runs here against a fake `ReplayIo`: no git, no tmux, no
// pi, no network, and no reviewed code is executed (scoping rule 2). Five
// properties are pinned because they are the safety argument, not the code:
//
//   1. the replay module holds NO mutation surface and never labels a PR — the
//      route (label it, let the daemon dispatch) is a posting path and
//      is not how this harness works;
//   2. `assertReplaySafe`'s three refusals bind per case, not only per run;
//   3. a scratch root that could collide with the daemon's worktrees is
//      refused;
//   4. a case whose recorded head is unreachable is REFUSED, never replayed
//      against whatever the PR ref points at today;
//   5. the session is always killed and the scratch tree always removed.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parseConfig, type Config } from "../src/config.js";
import { ReplayRefused, parseCaseSet, runRegression, type RegressionCase, type SandboxFinding } from "../src/regression.js";
import { isSandboxSession, prOfSession } from "../src/sessions.js";
import {
  FINDINGS_FILE,
  ReplayUnavailable,
  ScratchReplay,
  assertScratchIsolation,
  parseRegressionArgs,
  parseReplayFindings,
  replayOrder,
  replaySystemPrompt,
  runRegressionCli,
  type ExecOut,
  type ReplayIo,
} from "../src/replay.js";

const here = dirname(fileURLToPath(import.meta.url));
const SRC_PATH = join(here, "..", "src", "replay.ts");
const cfg: Config = parseConfig(readFileSync(resolve(process.cwd(), "config.toml"), "utf8"));
const set = parseCaseSet(JSON.parse(readFileSync(join(here, "fixtures", "regression-cases.json"), "utf8")));

const DRY = { isDryRun: true };
const LIVE = { isDryRun: false };
const SANDBOX = "/opt/quickreview";
const SCRATCH = "/opt/quickreview/state/regression";

interface FakeIo extends ReplayIo {
  calls: string[];
  files: Map<string, string>;
  spawned: string[];
  killed: string[];
  links: Array<[string, string]>;
}

/** A fake world. `gitOk` decides which git invocations succeed; anything the
 * replay writes lands in `files`, and the session "answers" by having its
 * findings file pre-seeded (or not). */
function fakeIo(opts: { answer?: unknown; missingHead?: boolean; hasClone?: boolean } = {}): FakeIo {
  const files = new Map<string, string>();
  const calls: string[] = [];
  const spawned: string[] = [];
  const killed: string[] = [];
  const links: Array<[string, string]> = [];
  let clock = 0;
  const io: FakeIo = {
    calls,
    files,
    spawned,
    killed,
    links,
    async exec(bin, args): Promise<ExecOut> {
      calls.push([bin, ...args].join(" "));
      if (args[0] === "cat-file") return { code: opts.missingHead ? 1 : 0, stdout: "", stderr: "" };
      if (args[0] === "merge-base") return { code: 0, stdout: "basesha\n", stderr: "" };
      if (args[0] === "diff") return { code: 0, stdout: "3\t1\tapp/handler.py\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    },
    async spawnSession(name) {
      spawned.push(name);
      // The session "answers" the moment it is spawned, if it answers at all.
      if (opts.answer !== undefined) files.set(join(SCRATCH, `pr-${set.cases[0]!.pr}`, FINDINGS_FILE), JSON.stringify(opts.answer));
    },
    async injectOrder(name, body) {
      calls.push(`inject ${name} ${body.length}`);
    },
    async killSession(name) {
      killed.push(name);
    },
    readFile: (p) => files.get(p) ?? null,
    writeFile: (p, b) => void files.set(p, b),
    mkdirp: () => {},
    rm: (p) => void files.delete(p),
    linkDir: (t, l) => void links.push([t, l]),
    sleep: async () => {
      clock += 1000;
    },
    now: () => clock,
  };
  return io;
}

function replayer(io: ReplayIo, over: Partial<ConstructorParameters<typeof ScratchReplay>[0]> = {}): ScratchReplay {
  return new ScratchReplay({
    gate: DRY,
    cfg,
    sandboxRoot: SANDBOX,
    scratchRoot: SCRATCH,
    io,
    timeoutMs: 10_000,
    pollMs: 1_000,
    runId: "t1",
    ...over,
  });
}

// The clone existence check is real fs; point the base clone at this repo's own
// .git so `prepareTree` gets past it in tests that are about something else.
const REPO = resolve(process.cwd());

/** The module's source with every comment removed. The bans below are about
 * what the CODE can do; the header prose has to be free to NAME the things it
 * forbids, or the ban becomes unwritable-about. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, "");
}

describe("a replay is not a posting path", () => {
  const src = readFileSync(SRC_PATH, "utf8");
  const code = codeOnly(src);

  it("imports no gate, no adapter and no daemon at runtime", () => {
    const runtimeImports = [...src.matchAll(/^import\s+(?!type\s)[^;]*from\s+"([^"]+)"/gm)].map((m) => m[1]!);
    for (const forbidden of ["./gate.js", "./github.js", "./githubAuth.js", "./posting.js", "./daemon.js", "./wire.js", "./reconcile.js"]) {
      expect(runtimeImports, `${forbidden} is a mutation surface — a replay must not be able to reach one`).not.toContain(forbidden);
    }
    // Dynamic imports are the other door into a module; only the pi lifecycle
    // and the exec helper may come through it.
    const dynamic = [...src.matchAll(/await import\("([^"]+)"\)/g)].map((m) => m[1]!);
    expect(dynamic.sort()).toEqual(["./sessions.js", "./tmux.js"]);
  });

  it("carries no way to mutate GitHub and never labels a PR", () => {
    for (const banned of ["MutationGate(", "GitHubAdapter", "TokenMinter", "addLabel", "removeLabel", "createReview", "mint-token", "GH_TOKEN=", "fetch("]) {
      expect(code, `${banned} must not appear in the replay`).not.toContain(banned);
    }
    // The harness's mechanism, named so the ban is greppable.
    expect(code).not.toMatch(/trigger_label|dispatchOnce|applyInterpretation/);
  });

  // Rule 9: the two DAEMON-OWNED session kinds are `pr-<n>` and `overseer`. A
  // replay session is neither, and this is what keeps it that way — if its name
  // ever landed inside the sandbox namespace, the daemon's `adopt()` would pick
  // a leftover replay session up at boot and treat it as a PR's shepherd.
  it("spawns a session the daemon can never adopt", () => {
    const io = fakeIo();
    const name = replayer(io).sessionName(5263);
    expect(name).toBe("replay-t1-pr-5263");
    expect(isSandboxSession(name)).toBe(false);
    expect(prOfSession(name)).toBeUndefined();
  });

  it("only ever fetches from the upstream — it never pushes", () => {
    expect(code).not.toMatch(/"push"/);
  });

  it("tells the session, in words, that it posts nothing", () => {
    const prompt = replaySystemPrompt();
    expect(prompt).toContain("Post nothing, anywhere.");
    expect(prompt).toContain("Read only");
    expect(replayOrder({
      c: set.cases[0]!,
      treePath: "/tmp/tree",
      findingsPath: "/tmp/f.json",
      lenses: ["pass-baseline"],
      baseSha: "b",
      changedFiles: 1,
      degradedDiff: false,
    })).toContain("Post NOTHING");
  });
});

describe("the safety assertions bind per case", () => {
  it("refuses a live gate before touching git or pi", async () => {
    const io = fakeIo();
    await expect(replayer(io, { gate: LIVE }).replay(set.cases[0]!)).rejects.toBeInstanceOf(ReplayRefused);
    expect(io.calls).toEqual([]);
    expect(io.spawned).toEqual([]);
  });

  it("refuses an open PR and a contaminated case", async () => {
    const io = fakeIo();
    await expect(replayer(io).replay({ ...set.cases[0]!, prState: "OPEN" })).rejects.toThrow(/still-open/);
    await expect(replayer(io).replay({ ...set.cases[0]!, submittedAt: "2026-07-01T00:00:00Z" })).rejects.toThrow(/contamination cutoff/);
    expect(io.spawned).toEqual([]);
  });

  it("refuses a scratch root that could collide with the daemon's worktrees", () => {
    expect(() => assertScratchIsolation(SANDBOX, SANDBOX)).toThrow(/is the sandbox root/);
    expect(() => assertScratchIsolation(join(SANDBOX, "wt"), SANDBOX)).toThrow(/worktree area/);
    expect(() => assertScratchIsolation(join(SANDBOX, "wt", "pr-5362"), SANDBOX)).toThrow(/worktree area/);
    expect(() => assertScratchIsolation(SCRATCH, SANDBOX)).not.toThrow();
  });

  it("refuses a case whose recorded head is not reachable, rather than replaying today's head", async () => {
    const io = fakeIo({ missingHead: true });
    await expect(replayer(io, { baseClone: REPO }).replay(set.cases[0]!)).rejects.toThrow(/not reachable/);
    expect(io.spawned).toEqual([]);
  });

  it("says where to run it when there is no base clone", async () => {
    const io = fakeIo();
    await expect(replayer(io, { baseClone: "/nope/clone" }).replay(set.cases[0]!)).rejects.toBeInstanceOf(ReplayUnavailable);
  });
});

describe("one case, end to end", () => {
  const c = () => set.cases[0]!;

  it("checks the recorded sha out into a scratch tree, never wt/pr-<n>", async () => {
    const io = fakeIo({ answer: { findings: [] } });
    const r = replayer(io, { baseClone: REPO });
    await r.replay(c());
    expect(r.treePath(c().pr)).toContain("state/regression");
    expect(r.treePath(c().pr)).not.toContain("/wt/");
    expect(io.calls.some((k) => k === `git worktree add --detach ${r.treePath(c().pr)} ${c().headSha}`)).toBe(true);
  });

  it("gives the session the pass agents and the exec guard, and no scripts/", async () => {
    const io = fakeIo({ answer: { findings: [] } });
    await replayer(io, { baseClone: REPO }).replay(c());
    const linked = io.links.map(([, l]) => l);
    expect(linked).toContain(join(SCRATCH, "extensions"));
    expect(linked).toContain(join(SCRATCH, "state", "agents"));
    expect(linked.some((l) => l.endsWith("/scripts"))).toBe(false);
  });

  it("reads back what the session wrote", async () => {
    const io = fakeIo({
      answer: {
        findings: [
          { path: "app/handler.py", line: "42", tag: "[blocker]", text: "token may be None" },
          { path: "", text: "no path" },
          { path: "x.py", text: "  " },
        ],
      },
    });
    const out = await replayer(io, { baseClone: REPO }).replay(c());
    expect(out).toEqual([{ path: "app/handler.py", text: "token may be None", line: 42, tag: "[blocker]" }]);
  });

  it("returns nothing (and so scores VACUOUS) when the session never answers", async () => {
    const io = fakeIo();
    const out = await replayer(io, { baseClone: REPO }).replay(c());
    expect(out).toEqual([]);
  });

  it("always kills the session and removes the scratch tree", async () => {
    const io = fakeIo();
    const r = replayer(io, { baseClone: REPO });
    await r.replay(c());
    expect(io.killed).toEqual([r.sessionName(c().pr)]);
    expect(io.calls.filter((k) => k.startsWith("git worktree remove")).length).toBeGreaterThanOrEqual(1);
  });

  it("tears down even when the order-file write throws after the tree exists", async () => {
    // Adversarial finding (P2): a throw between prepareTree's success and the
    // old try/finally (which began only at the session spawn) skipped teardown
    // and leaked a registered scratch worktree.
    const io = fakeIo();
    io.writeFile = (p: string) => {
      if (p.endsWith("order.md")) throw new Error("disk full");
    };
    const r = replayer(io, { baseClone: REPO });
    await expect(r.replay(c())).rejects.toThrow(/disk full/);
    expect(io.spawned).toEqual([]); // it never got to the session…
    // …but teardown still ran: the kill is teardown's alone (prepareTree
    // never kills), and the second remove is teardown's (the first is
    // prepareTree's own pre-add cleanup).
    expect(io.killed).toEqual([r.sessionName(c().pr)]);
    expect(io.calls.filter((k) => k.startsWith("git worktree remove")).length).toBe(2);
  });
});

describe("the findings parser", () => {
  it("accepts a bare array, coerces digit strings, and invents nothing", () => {
    expect(parseReplayFindings([{ path: "a.py", line: "7", text: "x" }])).toEqual([{ path: "a.py", text: "x", line: 7 }]);
    expect(parseReplayFindings({ findings: [{ path: "a.py", body: "x" }] })).toEqual([{ path: "a.py", text: "x" }]);
    expect(parseReplayFindings({ findings: "nope" })).toEqual([]);
    expect(parseReplayFindings(null)).toEqual([]);
  });
});

describe("qcr regression", () => {
  const baseDeps = (over: Record<string, unknown> = {}) => ({
    loadCaseSet: () => set,
    gate: DRY,
    makeReplay: async () => async (): Promise<SandboxFinding[]> => [],
    reportPath: (ranAt: string) => `/reports/regression-${ranAt}.md`,
    writeReport: () => {},
    log: () => {},
    ...over,
  });

  it("parses its flags", () => {
    const a = parseRegressionArgs(["--set", "/s.json", "--clone", "/c", "--change", "addendum X", "--limit", "3", "--out", "/o.md"], true);
    expect(a).toEqual({ setPath: "/s.json", clonePath: "/c", changeUnderTest: "addendum X", limit: 3, outPath: "/o.md", json: true });
    expect(parseRegressionArgs([], false).changeUnderTest).toBe("(unnamed change)");
    expect(() => parseRegressionArgs(["--limit", "0"], false)).toThrow(/usage/);
  });

  it("writes the investigation and exits 0 even when everything was missed", async () => {
    let written = "";
    const code = await runRegressionCli(parseRegressionArgs(["--change", "x"], false), baseDeps({ writeReport: (_: string, b: string) => (written = b) }) as never);
    expect(code).toBe(0);
    expect(written).toContain("This is not a gate.");
  });

  it("exits 2 on a safety refusal and never builds a replay", async () => {
    let built = false;
    const code = await runRegressionCli(parseRegressionArgs([], false), baseDeps({
      gate: LIVE,
      makeReplay: async () => {
        built = true;
        return async () => [];
      },
    }) as never);
    expect(code).toBe(2);
    expect(built).toBe(false);
  });

  it("exits 3 with an actionable message when pi is not on this machine", async () => {
    const lines: string[] = [];
    const code = await runRegressionCli(parseRegressionArgs([], false), baseDeps({
      makeReplay: async () => {
        throw new ReplayUnavailable("regression replay: no base clone at /x. Run this where the sandbox's clone lives");
      },
      log: (l: string) => lines.push(l),
    }) as never);
    expect(code).toBe(3);
    expect(lines.join("\n")).toContain("no base clone");
  });

  it("honours --limit so a first run is cheap", async () => {
    const seen: RegressionCase[] = [];
    await runRegressionCli(parseRegressionArgs(["--limit", "2"], false), baseDeps({
      makeReplay: async () => async (c: RegressionCase) => {
        seen.push(c);
        return [];
      },
    }) as never);
    expect(seen).toHaveLength(2);
  });

  it("hands runRegression the same gate it asserted against", async () => {
    let handed: unknown;
    await runRegressionCli(parseRegressionArgs([], false), baseDeps({
      run: async (cases: RegressionCase[], deps: { gate: unknown }) => {
        handed = deps.gate;
        return runRegression(cases, { replay: async () => [], gate: DRY });
      },
    }) as never);
    expect(handed).toBe(DRY);
  });
});
