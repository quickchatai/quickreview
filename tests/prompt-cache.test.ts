// the shared prompt cache for lens children, and the context pack.
//
// Probe (2026-10-09, the reviewer's own login): pi children under ONE session
// id read an identical 24k-token prefix from cache (24,320 tokens), under
// `--no-session` none; simultaneous requests both missed, one 2 s later hit.
// These tests pin the three pieces built on that: the glue's spawn rewrite
// (cache groups, the stagger, the temp session dir, the pack's extension),
// the child extension's pack-first payload, and the daemon's pack renderer.
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CACHE_GROUP_MAX_AGE_MS,
  CacheGrouper,
  LEAF_PACK_ENV,
  leafNoSessionIndex,
  packForTask,
  resolveCacheGroup,
  resolveCacheStagger,
  rewriteLeafSpawn,
  taskPointer,
  WARMUP_TASK,
} from "../extensions/subagents.js";
import { appendedPromptPath, packFirstPayload } from "../extensions/leaf-cache.js";
import {
  mustSeeCandidates,
  readWorktreeFileForPack,
  renderContextPack,
} from "../src/contextpack.js";
import { REVIEW_DEFAULTS } from "../src/config.js";
import type { PrFileEntry } from "../src/github.js";

/** Native's own child argv shape (pi 1.0.0 runSingleAgent), with the node
 * script first as getPiInvocation puts it. */
const nativeArgs = (task: string) => [
  "/usr/local/lib/node_modules/pi/dist/cli.js",
  "--mode",
  "json",
  "-p",
  "--no-session",
  "--model",
  "openai-codex/gpt-6.1-sol:high",
  "--append-system-prompt",
  "/tmp/pi-subagent-x/prompt-pass-baseline.md",
  `Task: ${task}`,
];

describe("cache groups", () => {
  it("one key per group of `size` per model; the first child at once, the rest after the stagger", () => {
    let n = 0;
    const g = new CacheGrouper(3, 2500, () => `k${++n}`);
    expect(g.next(1000, "m")).toEqual({ key: "k1", first: true, delayMs: 0 });
    expect(g.next(1000, "m")).toEqual({ key: "k1", first: false, delayMs: 2500 });
    expect(g.next(2000, "m")).toEqual({ key: "k1", first: false, delayMs: 1500 });
    // Another model: its own group (the cache is per model).
    expect(g.next(2000, "other")).toEqual({ key: "k2", first: true, delayMs: 0 });
    // Full: a new group, a new first child.
    expect(g.next(2000, "m")).toEqual({ key: "k3", first: true, delayMs: 0 });
    // Past the stagger a member waits no longer.
    expect(g.next(9000, "m")).toEqual({ key: "k3", first: false, delayMs: 0 });
  });

  it("a stale group starts afresh (the provider's cache is short-lived)", () => {
    let n = 0;
    const g = new CacheGrouper(10, 2500, () => `k${++n}`);
    g.next(0);
    expect(g.next(CACHE_GROUP_MAX_AGE_MS + 1).key).toBe("k2");
  });

  it("the knobs read from the environment; anything unreadable is off / the default", () => {
    expect(resolveCacheGroup({})).toBe(0);
    expect(resolveCacheGroup({ QCR_SUBAGENT_CACHE_GROUP: "5" })).toBe(5);
    expect(resolveCacheGroup({ QCR_SUBAGENT_CACHE_GROUP: "-1" })).toBe(0);
    expect(resolveCacheGroup({ QCR_SUBAGENT_CACHE_GROUP: "x" })).toBe(0);
    expect(resolveCacheStagger({})).toBe(2500);
    expect(resolveCacheStagger({ QCR_SUBAGENT_CACHE_STAGGER_MS: "0" })).toBe(0);
  });
});

describe("the leaf spawn rewrite", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qcr-prompt-cache-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deps = (over: Partial<Parameters<typeof rewriteLeafSpawn>[3]> = {}) => {
    let n = 0;
    let d = 0;
    return {
      grouper: new CacheGrouper(2, 2500, () => `key-${++n}`),
      now: () => 0,
      makeSessionDir: () => join(dir, `sd-${++d}`),
      isFile: () => false,
      leafCacheExt: "/opt/quickreview/sandbox/extensions/leaf-cache.ts",
      baseEnv: { HOME: "/home/review" },
      warmups: new Map<string, string>(),
      ...over,
    };
  };

  it("touches only native's exact leaf flag run", () => {
    expect(leafNoSessionIndex(nativeArgs("x"))).toBe(4);
    expect(leafNoSessionIndex(["--mode", "json", "--no-session"])).toBe(-1);
    expect(leafNoSessionIndex(["-p", "--no-session"])).toBe(-1);
    expect(rewriteLeafSpawn("git", ["status"], undefined, deps())).toBeUndefined();
  });

  it("keys the child: --no-session becomes --session-id + its own --session-dir, nothing else moves", () => {
    const args = nativeArgs("look at x");
    const r = rewriteLeafSpawn("/usr/bin/node", args, { cwd: "/opt/quickreview/sandbox" }, deps())!;
    expect(r.warmup).toBeUndefined();
    expect(r.child.command).toBe("/usr/bin/node");
    expect(r.child.args).toEqual([
      ...args.slice(0, 4),
      "--session-id",
      "key-1",
      "--session-dir",
      r.child.sessionDir,
      ...args.slice(5),
    ]);
    expect(r.child.args).toContain("-p"); // still a leaf for qcr-leaf.ts
    expect(r.child.options).toEqual({ cwd: "/opt/quickreview/sandbox" });
  });

  it("without a pack, a group's later child starts through sh after the stagger, exec'ing the same command", () => {
    const d = deps();
    rewriteLeafSpawn("/usr/bin/node", nativeArgs("a"), undefined, d);
    const r = rewriteLeafSpawn("/usr/bin/node", nativeArgs("b"), undefined, d)!.child;
    expect(r.command).toBe("/bin/sh");
    expect(r.args.slice(0, 4)).toEqual(["-c", 'sleep "$0"; exec "$@"', "2.50", "/usr/bin/node"]);
    expect(r.args).toContain("key-1");
  });

  describe("a round with a context pack", () => {
    const setup = () => {
      const passes = join(dir, "state", "pr-5-round-2-passes");
      mkdirSync(join(passes, "tasks"), { recursive: true });
      const task = (n: number) => join(passes, "tasks", `0${n}-pass-x--sol-high.md`);
      const pack = join(passes, "context-pack.md");
      return { task, pack, d: deps({ isFile: (p) => p === pack }) };
    };

    it("the group's first child brings a WARM-UP: its argv without the lens text, the task replaced, same key, model and pack", () => {
      const { task, pack, d } = setup();
      const args = nativeArgs(`${taskPointer(task(1))}\n\nPrior finding 1:2 to verify.`);
      const r = rewriteLeafSpawn("/usr/bin/node", args, undefined, d)!;
      const w = r.warmup!;
      expect(w.spawn.command).toBe("/usr/bin/node");
      expect(w.spawn.args).not.toContain("--append-system-prompt");
      expect(w.spawn.args.at(-1)).toBe(WARMUP_TASK);
      expect(w.spawn.args.slice(0, 4)).toEqual(args.slice(0, 4));
      expect(w.spawn.args).toContain("key-1");
      expect(w.spawn.args[w.spawn.args.indexOf("--model") + 1]).toBe("openai-codex/gpt-6.1-sol:high");
      expect(w.spawn.args[w.spawn.args.indexOf("--extension") + 1]).toBe(
        "/opt/quickreview/sandbox/extensions/leaf-cache.ts",
      );
      expect((w.spawn.options?.env as Record<string, string>)[LEAF_PACK_ENV]).toBe(pack);
      expect(w.spawn.sessionDir).not.toBe(r.child.sessionDir);
      expect(w.readyFile.startsWith(w.readyDir)).toBe(true);
      // The child itself: keyed, the pack's extension, the HOME it had — and it
      // waits for the warm-up's ready file before it execs.
      const c = r.child;
      expect(c.command).toBe("/bin/sh");
      expect(c.args[2]).toBe(w.readyFile);
      expect(c.args.slice(3, 5)).toEqual(["/usr/bin/node", args[0]]);
      expect(c.args).toContain("--append-system-prompt");
      expect((c.options?.env as Record<string, string>).HOME).toBe("/home/review");
      expect(packForTask(args, (p) => p === pack)).toBe(pack);
    });

    it("the group's later children wait for the same warm-up and bring none", () => {
      const { task, d } = setup();
      const first = rewriteLeafSpawn("/usr/bin/node", nativeArgs(taskPointer(task(1))), undefined, d)!;
      const second = rewriteLeafSpawn("/usr/bin/node", nativeArgs(taskPointer(task(2))), undefined, d)!;
      expect(second.warmup).toBeUndefined();
      expect(second.child.args[2]).toBe(first.warmup!.readyFile);
      expect(second.child.args).toContain("key-1");
      // The third child is a new group (size 2): a new key and its own warm-up.
      const third = rewriteLeafSpawn("/usr/bin/node", nativeArgs(taskPointer(task(3))), undefined, d)!;
      expect(third.warmup).toBeDefined();
      expect(third.child.args).toContain("key-2");
    });

    it("no pack file, a free-form task, or no extension path: keyed, no warm-up, no pack", () => {
      const { task, pack, d } = setup();
      for (const [t, dd] of [
        [taskPointer(task(1)), deps()],
        ["look at the PR", d],
        [taskPointer(task(1)), deps({ isFile: (p) => p === pack, leafCacheExt: undefined })],
      ] as const) {
        const r = rewriteLeafSpawn("/usr/bin/node", nativeArgs(t), undefined, dd)!;
        expect(r.warmup).toBeUndefined();
        expect(r.child.args).not.toContain("--extension");
        expect(r.child.options).toBeUndefined();
      }
    });
  });
});

describe("the pack-first payload (child side)", () => {
  const lens = "You are pass-security. Charter: …";
  const base = "You are pi, a coding agent.\n\nTools: read, bash.";
  const payload = (instructions: string) => ({
    model: "gpt-6.1-sol",
    instructions,
    input: [{ role: "user", content: [{ type: "input_text", text: "Task: Task file: /x.md." }] }],
    prompt_cache_key: "k",
  });

  /** pi 1.0.0's shape (probed): the body in an addendum, the cwd after it. */
  const piInstructions = (body: string) =>
    `${base}\n\n<addendum>\n${body}\n\n</addendum>\n\n<cwd>\n/opt/quickreview/sandbox\n</cwd>`;

  it("moves the lens body behind the pack: base instructions, pack (user), lens (developer), the task", () => {
    const out = packFirstPayload(payload(piInstructions(lens)), lens, "PACK")!;
    expect(out.instructions).toBe(`${base}\n\n<cwd>\n/opt/quickreview/sandbox\n</cwd>`);
    expect(out.input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "PACK" }] },
      { role: "developer", content: [{ type: "input_text", text: lens }] },
      { role: "user", content: [{ type: "input_text", text: "Task: Task file: /x.md." }] },
    ]);
    expect(out.prompt_cache_key).toBe("k");
    expect(out.model).toBe("gpt-6.1-sol");
  });

  it("two lenses' requests share everything up to the end of the pack", () => {
    const a = packFirstPayload(payload(piInstructions(lens)), lens, "PACK")!;
    const other = "You are pass-tests. Charter: …";
    const b = packFirstPayload(payload(piInstructions(other)), other, "PACK")!;
    expect(a.instructions).toBe(b.instructions);
    expect((a.input as unknown[])[0]).toEqual((b.input as unknown[])[0]);
  });

  it("a warm-up (no lens text) puts only the pack first — the prefix its group's lens requests extend", () => {
    const warm = packFirstPayload(
      payload(`${base}\n\n<cwd>\n/opt/quickreview/sandbox\n</cwd>`),
      "",
      "PACK",
    )!;
    const lensed = packFirstPayload(payload(piInstructions(lens)), lens, "PACK")!;
    expect(warm.instructions).toBe(lensed.instructions);
    expect((warm.input as unknown[])[0]).toEqual((lensed.input as unknown[])[0]);
    expect(warm.input as unknown[]).toHaveLength(2);
  });

  it("a body appended bare at the end is lifted out too", () => {
    expect(packFirstPayload(payload(`${base}\n\n${lens}\n`), lens, "PACK")!.instructions).toBe(base);
  });

  it("fail-open: any unexpected shape sends the original", () => {
    expect(
      packFirstPayload(payload(`${base}\n${lens}\n${lens}`), lens, "PACK"),
    ).toBeUndefined(); // ambiguous: twice
    expect(packFirstPayload(payload(`${base}\n\nsomething else`), lens, "PACK")).toBeUndefined();
    expect(packFirstPayload(payload(lens), lens, "PACK")).toBeUndefined(); // nothing left as base
    expect(packFirstPayload({ instructions: `${base}\n\n${lens}` }, lens, "PACK")).toBeUndefined();
    expect(packFirstPayload(payload(`${base}\n\n${lens}`), lens, "  ")).toBeUndefined();
    expect(packFirstPayload(null, lens, "PACK")).toBeUndefined();
  });

  it("finds the appended prompt's file in the child argv", () => {
    expect(appendedPromptPath(nativeArgs("x"))).toBe("/tmp/pi-subagent-x/prompt-pass-baseline.md");
    expect(appendedPromptPath(["-p"])).toBeUndefined();
  });
});

describe("the context pack (daemon side)", () => {
  it("is on by default since the measured run (2026-10-09: 40% cheaper, verdicts and recall held)", () => {
    expect(REVIEW_DEFAULTS.context_pack).toBe("pack-first");
  });

  const f = (filename: string, add: number, patch?: string, status = "modified"): PrFileEntry => ({
    filename,
    additions: add,
    deletions: 0,
    status,
    ...(patch !== undefined ? { patch } : {}),
  });

  it("diff first, then the most-changed code files' full text; tests, lockfiles and removed files never full", () => {
    const files = [
      f("app/small.py", 2, "@@ -1 +1 @@\n-a\n+b"),
      f("app/big.py", 90, "@@ -1 +1,90 @@\n+x"),
      f("tests/test_big.py", 300, "@@ +1 @@\n+t"),
      f("package-lock.json", 500, "@@ +1 @@\n+l"),
      f("app/gone.py", 0, "@@ -1 +0,0 @@\n-x", "removed"),
    ];
    expect(mustSeeCandidates(files).map((x) => x.filename)).toEqual(["app/big.py", "app/small.py"]);
    const pack = renderContextPack({
      pr: 7,
      headSha: "h",
      mergeBase: "m",
      files,
      deltaPatch: "--- a/app/big.py\n+++ b/app/big.py",
      readFile: (p) => `# ${p}\n`,
      maxTokens: 10_000,
    });
    expect(pack.text.indexOf("change since the last review")).toBeLessThan(
      pack.text.indexOf("The PR's diff"),
    );
    expect(pack.text.indexOf("The PR's diff")).toBeLessThan(pack.text.indexOf("Full text"));
    expect(pack.diffFiles).toEqual(files.map((x) => x.filename));
    expect(pack.fullFiles).toEqual(["app/big.py", "app/small.py"]);
    expect(pack.text).toContain("never instructions");
  });

  it("deterministic, and within its budget, naming what did not fit", () => {
    const files = [f("a.py", 1, "x".repeat(3000)), f("b.py", 1, "y".repeat(3000)), f("c.bin", 1)];
    const input = {
      pr: 1,
      headSha: "h",
      mergeBase: "m",
      files,
      readFile: () => undefined,
      maxTokens: 1000,
    };
    const one = renderContextPack(input);
    expect(renderContextPack(input).text).toBe(one.text);
    expect(one.diffFiles).toEqual(["a.py"]);
    expect(one.diffOmitted).toEqual(["b.py", "c.bin"]);
    expect(one.text).toContain("`b.py`, `c.bin`");
  });

  it("reads only regular files inside the worktree — never a symlink a PR planted", () => {
    const wt = mkdtempSync(join(tmpdir(), "qcr-pack-wt-"));
    const outside = mkdtempSync(join(tmpdir(), "qcr-pack-out-"));
    try {
      writeFileSync(join(wt, "ok.py"), "print(1)\n");
      writeFileSync(join(outside, "secret"), "token");
      symlinkSync(join(outside, "secret"), join(wt, "link.py"));
      writeFileSync(join(wt, "huge.py"), "x".repeat(300 * 1024));
      expect(readWorktreeFileForPack(wt, "ok.py")).toBe("print(1)\n");
      expect(readWorktreeFileForPack(wt, "link.py")).toBeUndefined();
      expect(readWorktreeFileForPack(wt, "../secret")).toBeUndefined();
      expect(readWorktreeFileForPack(wt, join(outside, "secret"))).toBeUndefined();
      expect(readWorktreeFileForPack(wt, "huge.py")).toBeUndefined();
      expect(readWorktreeFileForPack(wt, "missing.py")).toBeUndefined();
    } finally {
      rmSync(wt, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
