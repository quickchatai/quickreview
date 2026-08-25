// The single-shepherd invariant (docs/single-shepherd-invariant.md): one main
// pi per PR owns the review, the daemon only nudges, every agent runs through
// the pi-subagents extension launched by that one pi, and it is never given two
// instructions at once.
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBashCommand } from "../extensions/bash-guard.js";
import type { Config } from "../src/config.js";
import { LEAF_MEMORY_TOOLS, buildAgents, stripAgentSpawnTools } from "../src/include.js";
import { OVERSEER_SESSION, PiSessionManager, isSandboxSession } from "../src/sessions.js";
import { MAX_HELD_WAKES, StateStore } from "../src/state.js";
import { Tmux } from "../src/tmux.js";
import type { ExecFn } from "../src/tmux.js";
import { flushHeldWakes, wakeOrHold } from "../src/wakes.js";
import { WorktreeManager } from "../src/worktrees.js";

// ---- S1/S2: the daemon spawns two session kinds and launches no agent ------

/** Every .ts under src/, recursively. */
function srcFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? srcFiles(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : [],
  );
}

describe("daemon topology", () => {
  const src = join(import.meta.dirname, "..", "src");

  it("S1: only sessions.ts and the smoke script may birth a pi session", () => {
    // sessions.ts owns the two DAEMON-OWNED kinds. smoke-session.ts and
    // replay.ts are operator one-shots, not daemon topology: both
    // run only under an explicit `qcr`/`npm run` invocation, spawn a session
    // whose name is outside the `pr-<n>`/`overseer` namespace (so `adopt()`
    // can never pick one up — pinned in tests/replay.test.ts), and kill it
    // before returning. The replay's session additionally owns no PR, holds no
    // gate and posts nothing; its whole contract is "read a scratch tree,
    // write one JSON file".
    const offenders = srcFiles(src)
      .filter((f) => !["sessions.ts", "smoke-session.ts", "replay.ts"].includes(f.slice(f.lastIndexOf("/") + 1)))
      .filter((f) => /\bspawnSession\s*\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("S1: the session namespace is exactly pr-<n> plus overseer", () => {
    expect(isSandboxSession("pr-5263")).toBe(true);
    expect(isSandboxSession(OVERSEER_SESSION)).toBe(true);
    for (const name of ["pass-security--sol-high", "pr-5263-pass", "companion", "reviewer"]) {
      expect(isSandboxSession(name), name).toBe(false);
    }
  });

  //. A PR's OpenViking session shares the PR session's NAME and is not
  // a session in this invariant's sense: it is a row in the memory store that
  // the daemon creates and deletes over HTTP — nothing schedules it, nothing
  // runs in it, no pi process is attached to it, and it never appears in tmux.
  // The two daemon-owned pi session kinds are still exactly `pr-<n>` and
  // `overseer`.
  it("S1: an OpenViking session is a store object, not a daemon-owned pi session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-ov-"));
    try {
      mkdirSync(join(dir, "prompts"), { recursive: true });
      writeFileSync(join(dir, "prompts", "conversation-system.md"), "shepherd of #{{n}}\n");
      const live = new Set<string>();
      const ov: string[] = [];
      const exec: ExecFn = async (cmd, args) => {
        if (cmd === "tmux") {
          if (args[0] === "has-session") return { code: live.has(String(args[2]).replace(/^=/, "")) ? 0 : 1, stdout: "", stderr: "" };
          if (args[0] === "new-session") live.add(String(args[3]));
          if (args[0] === "list-sessions") return { code: 0, stdout: [...live].join("\n"), stderr: "" };
          if (args[0] === "kill-session") live.delete(String(args[2]).replace(/^=/, ""));
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const m = new PiSessionManager({
        cfg: {
          github: { repo: "o/n", secrets_dir: join(dir, "secrets") },
          pi: { version: "0.84.1", session_dir: "state/pi-sessions" },
          models: { conversation: "openai/conv" },
        } as unknown as Config,
        root: dir,
        tmux: new Tmux({ exec }),
        worktrees: new WorktreeManager({ root: dir, repo: "o/n", cloneUrl: "/dev/null", run: exec }),
        ovSessions: {
          create: async (id) => {
            ov.push(`create ${id}`);
            return true;
          },
          remove: async (id) => {
            ov.push(`delete ${id}`);
            return true;
          },
        },
      });

      await m.ensurePrSession(5263, "t", "wt/pr-5263");
      // One pi session was born; the OpenViking session was CREATED, not spawned.
      expect([...live]).toEqual(["pr-5263"]);
      expect(ov).toEqual(["create pr-5263"]);
      // …and it is invisible to every session-topology surface.
      const adoption = await m.adopt();
      expect(adoption.adopted).toEqual(["pr-5263"]);
      expect(adoption.prs).toEqual([5263]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("S2: no daemon module invokes pi outside the session manager", () => {
    // sessions.ts owns the daemon's pi argv. smoke-session.ts is the operator's
    // one-shot session smoke. tui/companion.ts is the COMPANION boundary — a
    // local container on the owner's PC that never reaches GitHub or the gate
    // (CLAUDE.md hard rule 8), so its own pi argv is not a daemon spawn.
    const allowed = ["sessions.ts", "smoke-session.ts", "companion.ts"];
    const offenders = srcFiles(src)
      .filter((f) => !allowed.includes(f.slice(f.lastIndexOf("/") + 1)))
      .filter((f) => /["'`]pi["'`]\s*,|piBin|--no-session/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("S4: every PR-session wake goes through wakes.ts", () => {
  const src = join(import.meta.dirname, "..", "src");

  it("the author-reply path calls wakeOrHold, never inject directly", () => {
    const text = readFileSync(join(src, "daemon.ts"), "utf8");
    const start = text.indexOf("onAuthorReply:");
    const end = text.indexOf("onClosed:", start);
    expect(start).toBeGreaterThan(-1);
    const block = text.slice(start, end);
    expect(block).toContain("wakeOrHold(");
    expect(block).not.toMatch(/await\s+hooks\.inject\(/);
  });

  it("no other module wakes a PR session behind wakes.ts's back", () => {
    // Allowed: wakes.ts itself; the two call sites that hand it an inject seam
    // (daemon author replies, verdict/anomaly flush); wire.ts's pass-through
    // decorator. Anything else is a second instruction channel to the one main
    // pi — exactly what S4 forbids. (src/replay.ts delivers ONE order to a
    // throwaway replay session and deliberately does not spell that
    // `inject(pr, …)`: a replay session owns no PR, runs no round and can
    // therefore never be mid-round, so there is nothing for wakes.ts to hold.)
    const allowed = new Set(["wakes.ts", "daemon.ts", "verdicts.ts", "wire.ts"]);
    const offenders = srcFiles(src)
      .filter((f) => !allowed.has(f.slice(f.lastIndexOf("/") + 1)))
      .filter((f) => {
        const text = readFileSync(f, "utf8");
        // A PR-session wake takes (pr, message); overseer injects take one arg.
        return /\.inject\(\s*[a-zA-Z_][\w.]*\s*,/.test(text);
      });
    expect(offenders).toEqual([]);
  });
});

// ---- S3: passes are leaves ------------------------------------------------

describe("stripAgentSpawnTools", () => {
  it("drops agent-spawning tools and keeps the read-only ones", () => {
    expect(stripAgentSpawnTools("tools: read, bash, subagent, grep\n")).toBe("tools: read, bash, grep\n");
    expect(stripAgentSpawnTools("tools: read, Task, agent, glob\n")).toBe("tools: read, glob\n");
  });

  it("leaves a clean tools line untouched", () => {
    expect(stripAgentSpawnTools("name: x\ntools: read, bash, grep, glob\n")).toBe("name: x\ntools: read, bash, grep, glob\n");
  });

  it("removes the line entirely when nothing survives (empty ≠ absent)", () => {
    expect(stripAgentSpawnTools("name: x\ntools: subagent\n")).not.toContain("tools:");
  });

  it("is a no-op when there is no tools line", () => {
    expect(stripAgentSpawnTools("name: x\nmodel: y\n")).toBe("name: x\nmodel: y\n");
  });
});

describe("buildAgents — built passes cannot launch agents", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "shepherd-agents-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("strips a spawn tool a seed might grow, and states the leaf rule", () => {
    const src = join(dir, "agents");
    const out = join(dir, "built");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "pass-baseline.md"),
      "---\nname: pass-baseline\ntools: read, bash, subagent, grep\nmodel: openai/x\n---\n\nbody\n",
    );

    const built = buildAgents(src, out, { riskPasses: [], validateTier: "terra-med" });
    expect(built.length).toBeGreaterThan(0);
    for (const agent of built) {
      const text = readFileSync(agent.output, "utf8");
      const frontmatter = text.slice(0, text.indexOf("\n---\n", 3));
      expect(frontmatter).not.toMatch(/\bsubagent\b/);
      expect(frontmatter).toContain("read, bash, grep");
      expect(text).toContain("You are a leaf");
      expect(text).toContain("never launch another agent");
    }
  });

  // leaves may LOOK THINGS UP and may not write. Two layers — this
  // allowlist decides which memory tools exist inside a leaf at all, and the
  // vendored fork's PATCH 2 withholds `viking_write` in any leaf process.
  it("gives a leaf read-only memory and no way to author anything", () => {
    const src = join(dir, "agents");
    const out = join(dir, "built");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "pass-baseline.md"),
      "---\nname: pass-baseline\ntools: read, grep, viking_write\nmodel: openai/x\n---\n\nbody\n",
    );

    for (const agent of buildAgents(src, out, { riskPasses: [], validateTier: "terra-med" })) {
      const text = readFileSync(agent.output, "utf8");
      const tools = /^tools:[ \t]*(.*)$/m.exec(text)![1]!.split(",").map((t) => t.trim());
      expect(tools.filter((t) => t.startsWith("viking_"))).toEqual([...LEAF_MEMORY_TOOLS]);
      expect(tools).not.toContain("viking_write");
      expect(text).toContain("You have no write tool and will not be given one.");
    }
  });

  it("leaves the canonical seeds byte-identical", () => {
    const src = join(dir, "agents");
    const out = join(dir, "built");
    mkdirSync(src, { recursive: true });
    const seed = "---\nname: pass-ui\ntools: read, bash, grep, glob\n---\n\nseed body\n";
    writeFileSync(join(src, "pass-ui.md"), seed);
    buildAgents(src, out, { riskPasses: [], validateTier: "terra-med" });
    expect(readFileSync(join(src, "pass-ui.md"), "utf8")).toBe(seed);
  });
});

// ---- S3: bash is never an agent launcher ----------------------------------

describe("bash-guard — agent spawners are named explicitly", () => {
  for (const cmd of ["pi --no-session -p 'review'", "npx pi", "node runner.js", "claude -p x", "codex exec", "bun x pi"]) {
    it(`blocks: ${cmd}`, () => {
      const res = checkBashCommand(cmd);
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("subagent");
    });
  }

  it("still blocks a spawner hidden behind a substitution or an env prefix", () => {
    expect(checkBashCommand("X=\"$(cat f)\" pi -p go").allowed).toBe(false);
    expect(checkBashCommand("env FOO=1 node x.js").allowed).toBe(false);
    expect(checkBashCommand("cat f | xargs pi").allowed).toBe(false);
  });

  it("does not over-block the read-only surface", () => {
    expect(checkBashCommand("git log --oneline | head").allowed).toBe(true);
    expect(checkBashCommand("scripts/pr-context.sh 5263").allowed).toBe(true);
  });
});

// ---- S4: one instruction at a time ----------------------------------------

describe("wakeOrHold / flushHeldWakes", () => {
  let store: StateStore;
  let injected: Array<{ pr: number; message: string }>;
  const deps = (): { store: StateStore; inject: (pr: number, m: string) => Promise<void> } => ({
    store,
    inject: async (pr, message) => {
      injected.push({ pr, message });
    },
  });

  beforeEach(() => {
    store = new StateStore(":memory:");
    injected = [];
    store.upsertPr({
      number: 7,
      state: "tracked",
      head_sha: "abc",
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
  });
  afterEach(() => store.close());

  it("injects straight through when no round is running", async () => {
    expect(await wakeOrHold(deps(), 7, "hello", "author_reply")).toBe("injected");
    expect(injected).toEqual([{ pr: 7, message: "hello" }]);
    expect(store.heldWakes(7)).toHaveLength(0);
  });

  it("holds the wake while a round is in flight", async () => {
    store.startRound(7, "first", ["pass-baseline"], 75);
    expect(await wakeOrHold(deps(), 7, "hello", "author_reply")).toBe("held");
    expect(injected).toHaveLength(0);
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual(["hello"]);
  });

  it("does not hold a wake for a different PR's round", async () => {
    store.upsertPr({
      number: 8, state: "tracked", head_sha: "d", title: "t", author: "a",
      trigger_ts: null, stale_recheck: 0, migration_gate: 0,
    });
    store.startRound(8, "first", ["pass-baseline"], 75);
    expect(await wakeOrHold(deps(), 7, "hello", "author_reply")).toBe("injected");
  });

  it("flushes held wakes in arrival order, once", async () => {
    const id = store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "first reply", "author_reply");
    await wakeOrHold(deps(), 7, "second reply", "author_reply");
    store.finishRound(id, "APPROVE", null, null);

    expect(await flushHeldWakes(deps(), 7)).toBe(2);
    expect(injected.map((i) => i.message)).toEqual(["first reply", "second reply"]);
    expect(store.heldWakes(7)).toHaveLength(0);
    expect(await flushHeldWakes(deps(), 7)).toBe(0);
  });

  it("caps held wakes per PR, dropping the oldest with an event", async () => {
    store.startRound(7, "first", ["pass-baseline"], 75);
    for (let i = 0; i < MAX_HELD_WAKES + 2; i++) await wakeOrHold(deps(), 7, `m${i}`, "author_reply");
    const held = store.heldWakes(7);
    expect(held).toHaveLength(MAX_HELD_WAKES);
    expect(held[0]!.payload).toBe("m2"); // the two oldest were evicted
    expect(store.recentEvents(50).some((e) => e.kind === "wake_dropped")).toBe(true);
  });

  it("keeps flushing when one delivery fails", async () => {
    store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "a", "author_reply");
    await wakeOrHold(deps(), 7, "b", "author_reply");
    let calls = 0;
    const delivered = await flushHeldWakes(
      {
        store,
        inject: async (pr, message) => {
          calls++;
          if (calls === 1) throw new Error("session dead");
          injected.push({ pr, message });
        },
      },
      7,
    );
    expect(delivered).toBe(1);
    expect(injected.map((i) => i.message)).toEqual(["b"]);
    expect(store.heldWakes(7)).toHaveLength(0);
  });
});
