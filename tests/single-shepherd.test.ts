// The single-shepherd invariant (docs/single-shepherd-invariant.md): one main
// pi per PR owns the review, the daemon only nudges, every agent runs through
// the `subagent` tool (pi's native subagent extension, loaded per spawn by the
// first-party glue) launched by that one pi, and it is never given
// two instructions at once.
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkBashCommand } from "../extensions/bash-guard.js";
import type { Config } from "../src/config.js";
import { LEAF_MEMORY_TOOLS, buildAgents, stripAgentSpawnTools } from "../src/include.js";
import { writeSessionBridgeState } from "../src/session-bridge.js";
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
    e.isDirectory()
      ? srcFiles(join(dir, e.name))
      : e.name.endsWith(".ts")
        ? [join(dir, e.name)]
        : [],
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
      .filter(
        (f) =>
          !["sessions.ts", "smoke-session.ts", "replay.ts"].includes(
            f.slice(f.lastIndexOf("/") + 1),
          ),
      )
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
          if (args[0] === "has-session")
            return {
              code: live.has(String(args[2]).replace(/^=/, "")) ? 0 : 1,
              stdout: "",
              stderr: "",
            };
          if (args[0] === "new-session") {
            const session = String(args[3]);
            live.add(session);
            const generation = args
              .find((value) => value.startsWith("QCR_SESSION_BRIDGE_GENERATION="))
              ?.split("=", 2)[1];
            const stateFile = args
              .find((value) => value.startsWith("QCR_SESSION_BRIDGE_STATE_FILE="))
              ?.slice("QCR_SESSION_BRIDGE_STATE_FILE=".length);
            if (generation && stateFile) {
              writeSessionBridgeState(stateFile, {
                version: 1,
                session,
                generation,
                stage: "ready",
                updated_at: "2026-08-13T10:00:00.000Z",
              });
            }
          }
          if (args[0] === "list-sessions")
            return { code: 0, stdout: [...live].join("\n"), stderr: "" };
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
        worktrees: new WorktreeManager({
          root: dir,
          repo: "o/n",
          cloneUrl: "/dev/null",
          run: exec,
        }),
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
    // bench/runner.ts is the AACR-Bench sandbox's one-shot `pi -p` round: it
    // runs only inside the qcr-bench image (no daemon, no gate, no scripts/,
    // no credential), under a `bench-<id>` name no adopt() can match, and the
    // process exits when its round settles.
    // setup/caserunner.ts is the companion's survey/scan case
    // runner: it runs only inside the companion container (extensions/
    // setup.ts, never the daemon — the check below pins that no daemon module
    // imports src/setup/), and each spawn is a `-p --no-session
    // --no-extensions` leaf with read-only tools, not a session.
    const allowed = ["sessions.ts", "smoke-session.ts", "companion.ts"];
    const allowedPaths = ["/src/bench/runner.ts", "/src/setup/caserunner.ts"];
    const offenders = srcFiles(src)
      .filter((f) => !allowed.includes(f.slice(f.lastIndexOf("/") + 1)))
      .filter((f) => !allowedPaths.some((p) => f.endsWith(p)))
      .filter((f) => /["'`]pi["'`]\s*,|piBin|--no-session/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    // The case runner's allowance holds only while no daemon module can reach
    // it: src/setup/ is imported from src/setup/ and the companion's
    // extension — with leaf exceptions: setup/history.js (the
    // TUI's `qcr history pull` needs the digest's file name),
    // setup/stage2request.js (the TUI's stage-2 start click reads the
    // proposal and writes the request), and's three for the
    // operator's machine — pins.js (the TUI marks proposed pins),
    // configcommit.js (the TUI and `qcr setup commit` carry out the profile
    // commits setup asked for) and profile.js (`qcr setup validate`, the
    // daemon's own loaders over a profile), and's retunelog.js (the
    // deploy tab says which post-scan re-tune is not deployed), and
    // scanreport.js (the [8] scan tab reads the run record and the findings
    // store, and asks for a stop). Each leaf may reach the rest of
    // src/setup/ by TYPE only (erased at build), so no exception can ever
    // carry the case runner along with it.
    const setupLeaves = [
      "history.js",
      "stage2request.js",
      "pins.js",
      "configcommit.js",
      "profile.js",
      "retunelog.js",
      "scanreport.js",
    ];
    const reachesSetup = srcFiles(src)
      .filter((f) => !f.includes("/src/setup/"))
      .filter((f) =>
        [...readFileSync(f, "utf8").matchAll(/from\s+["'][^"']*\/setup\/([^"']*)["']/g)].some(
          (m) => !setupLeaves.includes(m[1]!),
        ),
      );
    expect(reachesSetup).toEqual([]);
    for (const leaf of setupLeaves) {
      const body = readFileSync(join(src, "setup", leaf.replace(/\.js$/, ".ts")), "utf8");
      const runtimeSibling = body
        .split("\n")
        .filter(
          (l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l) && /from\s+["']\.\//.test(l),
        );
      expect(runtimeSibling, `setup/${leaf} must reach its siblings by type only`).toEqual([]);
    }
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
    // The reply is claimed before the wake: a failed injection must hold it,
    // never drop it (selfscan 0df49200).
    expect(block).toContain("holdOnFailure: true");
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

  /**
   * / MC-10 — the assertion above greps for a CALL SHAPE, and the one
   * module that actually reaches a `pr-<n>` session from outside the daemon
   * does not use it: `src/tui/msg.ts` writes the inject FILE itself, over ssh,
   * with `docker exec … mv … inject/<session>/<name>.md`. The regex above
   * cannot see that, and never could — so the compliance audit was right that
   * the invariant survived on a layer the tests did not cover.
   *
   * This is the fence for the OTHER spelling: constructing an inject path.
   * It names the file rather than the call, so a future module that reaches a
   * PR session by writing the drop-box directly fails here even if it never
   * calls `.inject(pr, …)`.
   *
   * The allowlist is the point. `msg.ts` is a RATIFIED operator-initiated
   * exception (rule: "the board is read-only over ssh with exactly two
   * exceptions", the quick-message box being the first) — but it was
   * *invisible* to the suite, and an invisible exception is indistinguishable
   * from an oversight. Now it is written down, with what makes it legal.
   */
  it("only the sanctioned writers construct a session's inject drop-box path", () => {
    /**
     * An EXHAUSTIVE registry, checked by SET EQUALITY in both directions.
     *
     * A subset check would let the list rot: an entry whose module stopped
     * touching the drop-box would sit here forever, and a reader could no
     * longer tell which entries are load-bearing. Equality means adding a
     * writer fails here AND removing one does, so every line is live.
     */
    const INJECT_PATH_WRITERS: ReadonlyArray<{ file: string; why: string }> = [
      {
        file: "src/sessions.ts",
        why: "the daemon's own drop-box implementation — this IS the mailbox wakes.ts nudges through, and the bridge that drains it",
      },
      {
        file: "src/tui/msg.ts",
        why:
          "RATIFIED operator exception: the quick-message box (`m`) addresses a session the operator is NOT focused on. " +
          "Human-initiated, never automatic, carries no verdict, and reaches the same bridge the daemon uses. It " +
          "deliberately does not go through wakeOrHold — an operator asking a question mid-round is the operator's call. " +
          "This is the writer the `.inject(pr, …)` grep above structurally CANNOT see (MC-10), which is why this fence exists.",
      },
      {
        file: "src/tui/companion.ts",
        why: "the COMPANION session's dir (/workspace/inject/<companion session>) — a different container on the operator's PC, never a pr-<n> session (rule 8)",
      },
      {
        file: "src/cliops.ts",
        why:
          "`qcr checklist`'s offline ping-pong plumbing probe. Operator-run, one-shot, and scoped to the fixture PR " +
          "999902 — but it does write into the REAL inject/ tree, so it is a writer and is recorded as one.",
      },
    ];
    for (const w of INJECT_PATH_WRITERS) {
      expect(
        existsSync(join(src, "..", w.file)),
        `${w.file} is allowlisted but does not exist`,
      ).toBe(true);
      expect(w.why.length, `${w.file} needs a reason a stranger can check`).toBeGreaterThan(40);
    }

    // Comments are stripped first: several modules DESCRIBE the drop-box
    // without writing to it, and a fence that fires on prose gets muted.
    // BOTH spellings are detected — the path-segment form `…/inject/<x>` that
    // msg.ts and companion.ts use, and the `join(root, "inject", …)` form
    // sessions.ts uses. The first version of this fence caught only the first
    // spelling and passed a deliberately-planted rogue writer: a detector
    // tuned to today's call sites is the same false all-clear as grepping for
    // a name instead of a reader.
    const writers = srcFiles(src)
      .filter((f) => {
        const code = readFileSync(f, "utf8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .split("\n")
          .filter((l) => !/^\s*(\/\/|\*)/.test(l))
          .map((l) => l.replace(/\/\/.*$/, ""))
          .join("\n");
        return /inject\/|["']inject["']/.test(code);
      })
      .map((f) => f.slice(f.indexOf("/src/") + 1))
      .sort();

    expect(
      writers,
      "the set of modules that build a session inject path changed — route the new one through wakeOrHold, " +
        "or add it to INJECT_PATH_WRITERS with what makes it legal; if one dropped off, delete its entry",
    ).toEqual(INJECT_PATH_WRITERS.map((w) => w.file).sort());
  });
});

// ---- S3: passes are leaves ------------------------------------------------

describe("stripAgentSpawnTools", () => {
  it("drops agent-spawning tools and keeps the read-only ones", () => {
    expect(stripAgentSpawnTools("tools: read, bash, subagent, grep\n")).toBe(
      "tools: read, bash, grep\n",
    );
    expect(stripAgentSpawnTools("tools: read, Task, agent, glob\n")).toBe("tools: read, glob\n");
  });

  it("leaves a clean tools line untouched", () => {
    expect(stripAgentSpawnTools("name: x\ntools: read, bash, grep, glob\n")).toBe(
      "name: x\ntools: read, bash, grep, glob\n",
    );
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
      const tools = /^tools:[ \t]*(.*)$/m
        .exec(text)![1]!
        .split(",")
        .map((t) => t.trim());
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

// ---- S3: children never get the subagent tool (no nested fan-out) ---------
//
// the native extension's children spawn WITHOUT per-spawn argv
// extensions and load only the global settings.json list. The glue therefore
// rides argv (pinned in tests/sessions.test.ts / tests/tui-companion.test.ts),
// and the global registration lists in BOTH container boots must never grow a
// subagents entry — that is the structural guarantee that a leaf cannot fan
// out, and it holds no matter what a frontmatter says.
describe("subagents glue is never registered globally", () => {
  const root = join(import.meta.dirname, "..");
  for (const file of ["deploy/ansible/templates/entrypoint.sh.j2", "docker/daemon/entrypoint.sh"]) {
    it(`${file}: the global extension list carries no subagent loader`, () => {
      const text = readFileSync(join(root, file), "utf8");
      const wanted = /const wanted = \[([\s\S]*?)\];/.exec(text)?.[1] ?? "";
      const paths = [...wanted.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p, `${p} must not hand children an agent launcher or memory`).not.toMatch(
          /subagent|openviking|register-lens/,
        );
      }
    });
  }
});

// ---- S3: bash is never an agent launcher ----------------------------------

describe("bash-guard — agent spawners are named explicitly", () => {
  for (const cmd of [
    "pi --no-session -p 'review'",
    "npx pi",
    "node runner.js",
    "claude -p x",
    "codex exec",
    "bun x pi",
  ]) {
    it(`blocks: ${cmd}`, () => {
      const res = checkBashCommand(cmd);
      expect(res.allowed).toBe(false);
      expect(res.reason).toContain("subagent");
    });
  }

  it("still blocks a spawner hidden behind a substitution or an env prefix", () => {
    expect(checkBashCommand('X="$(cat f)" pi -p go').allowed).toBe(false);
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

  it("holds behind an existing durable PR-session command even with no round row", async () => {
    store.createSessionCommand({
      id: "cmd-active",
      pr: 7,
      session: "pr-7",
      kind: "wake",
      round_no: null,
      payload_sha256: "a".repeat(64),
      payload_path: "/state/cmd-active.md",
      inject_path: "/inject/pr-7/cmd-active.md",
      next_check_at: new Date(Date.now() + 120_000).toISOString(),
    });
    expect(await wakeOrHold(deps(), 7, "hello", "author_reply")).toBe("held");
    expect(injected).toHaveLength(0);
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual(["hello"]);
  });

  it("turns a concurrent slot-creation race into a durable hold instead of losing the wake", async () => {
    const racing = {
      store,
      inject: async () => {
        store.createSessionCommand({
          id: "cmd-racer",
          pr: 7,
          session: "pr-7",
          kind: "wake",
          round_no: null,
          payload_sha256: "b".repeat(64),
          payload_path: "/state/racer.md",
          inject_path: "/inject/pr-7/racer.md",
          next_check_at: new Date(Date.now() + 120_000).toISOString(),
        });
        throw new Error("UNIQUE constraint failed: session_commands.session");
      },
    };
    expect(await wakeOrHold(racing, 7, "do not lose me", "author_reply")).toBe("held");
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual(["do not lose me"]);
  });

  // Selfscan fce511c3: with no round and no command, a NEW wake injected
  // straight past older held wakes still waiting for the stranded sweep.
  it("a new wake never overtakes an existing held backlog", async () => {
    const id = store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "older reply", "author_reply");
    store.finishRound(id, "APPROVE", null, null);
    // The round is over, the backlog not yet flushed; a newer reply arrives.
    await wakeOrHold(deps(), 7, "newer reply", "author_reply");

    // Both go out oldest-first as one burst — never the newer one alone.
    expect(injected).toHaveLength(1);
    const burst = injected[0]!.message;
    expect(burst.indexOf("older reply")).toBeGreaterThan(-1);
    expect(burst.indexOf("older reply")).toBeLessThan(burst.indexOf("newer reply"));
    expect(store.heldWakes(7)).toHaveLength(0);
  });

  it("a new wake behind a backlog it cannot yet deliver stays held after it", async () => {
    const id = store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "older reply", "ledger_stale");
    store.finishRound(id, "APPROVE", null, null);
    const blocking = {
      store,
      inject: async (pr: number, message: string) => {
        injected.push({ pr, message });
        store.createSessionCommand({
          id: "cmd-older",
          pr,
          session: `pr-${pr}`,
          kind: "wake",
          round_no: null,
          payload_sha256: "c".repeat(64),
          payload_path: "/state/cmd-older.md",
          inject_path: `/inject/pr-${pr}/cmd-older.md`,
          next_check_at: new Date(Date.now() + 120_000).toISOString(),
        });
      },
    };
    expect(await wakeOrHold(blocking, 7, "newer reply", "author_reply")).toBe("held");
    expect(injected.map((w) => w.message)).toEqual(["older reply"]);
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual(["newer reply"]);
  });

  // Selfscan 0df49200: the daemon claims an author message BEFORE waking; an
  // injection that failed before any command existed threw the wake away and
  // the claim refused every redelivery — the reply was never answered.
  it("holdOnFailure turns an injection failure into a durable hold", async () => {
    const failing = {
      store,
      inject: async () => {
        throw new Error("session pr-7 failed to spawn");
      },
    };
    expect(await wakeOrHold(failing, 7, "answer me", "author_reply", { holdOnFailure: true })).toBe(
      "held",
    );
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual(["answer me"]);
    // Without the option the error still propagates (callers that release
    // their own claim on failure depend on it).
    await expect(wakeOrHold(failing, 8, "x", "recheck")).rejects.toThrow(/failed to spawn/);
  });

  it("does not hold a wake for a different PR's round", async () => {
    store.upsertPr({
      number: 8,
      state: "tracked",
      head_sha: "d",
      title: "t",
      author: "a",
      trigger_ts: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    store.startRound(8, "first", ["pass-baseline"], 75);
    expect(await wakeOrHold(deps(), 7, "hello", "author_reply")).toBe("injected");
  });

  it("flushes held author replies in arrival order, once", async () => {
    const id = store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "first reply", "author_reply");
    await wakeOrHold(deps(), 7, "second reply", "author_reply");
    store.finishRound(id, "APPROVE", null, null);

    expect(await flushHeldWakes(deps(), 7)).toBe(2);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.message.indexOf("first reply")).toBeLessThan(
      injected[0]!.message.indexOf("second reply"),
    );
    expect(store.heldWakes(7)).toHaveLength(0);
    expect(await flushHeldWakes(deps(), 7)).toBe(0);
  });

  it("coalesces five author replies into one durable run without losing any response obligation", async () => {
    const id = store.startRound(7, "first", ["pass-baseline"], 75);
    for (let comment = 101; comment <= 105; comment++) {
      await wakeOrHold(
        deps(),
        7,
        `# Author reply — PR #7\n\nWrite exactly one response file at \`verdict/pr-7-thread-9-comment-${comment}.json\``,
        "author_reply",
      );
    }
    store.finishRound(id, "APPROVE", null, null);
    const durableDeps = {
      store,
      inject: async (pr: number, message: string) => {
        injected.push({ pr, message });
        store.createSessionCommand({
          id: "cmd-batch",
          pr,
          session: `pr-${pr}`,
          kind: "wake",
          round_no: null,
          payload_sha256: "b".repeat(64),
          payload_path: "/state/cmd-batch.md",
          inject_path: `/inject/pr-${pr}/cmd-batch.md`,
          next_check_at: new Date(Date.now() + 120_000).toISOString(),
        });
      },
    };

    expect(await flushHeldWakes(durableDeps, 7)).toBe(5);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.message).toContain("Process every author message below independently");
    for (let comment = 101; comment <= 105; comment++) {
      expect(injected[0]!.message).toContain(`verdict/pr-7-thread-9-comment-${comment}.json`);
    }
    expect(store.heldWakes(7)).toHaveLength(0);

    // A queued merits obligation remains behind exactly this one durable run,
    // then becomes dispatchable as soon as that run settles — never five
    // serialized author-reply runs.
    const current = store.getPr(7)!;
    store.upsertPr({ ...current, state: "queued", trigger_ts: new Date().toISOString() });
    const canDispatch = (): boolean =>
      store.getPr(7)?.state === "queued" && !store.blockingSessionCommand("pr-7");
    expect(canDispatch()).toBe(false);
    const deadline = new Date(Date.now() + 120_000).toISOString();
    store.claimSessionCommand("cmd-batch", "bridge-batch", deadline);
    store.markSessionCommandStarted("cmd-batch", "bridge-batch", deadline);
    store.finishSessionCommand("cmd-batch", "bridge-batch", "acked");
    expect(canDispatch()).toBe(true);
  });

  it("never lets cap trimming evict a leased author-reply batch during injection", async () => {
    for (let comment = 301; comment <= 305; comment++) {
      store.holdWake(7, `# Author reply — PR #7\n\ncomment ${comment}`, "author_reply");
    }
    let accept!: () => void;
    const injecting = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const flush = flushHeldWakes({ store, inject: async () => injecting }, 7);
    await vi.waitFor(() =>
      expect(store.heldWakes(7).every((wake) => wake.claim_token !== null)).toBe(true),
    );

    const dropped = store.holdWake(7, "arrived while the batch was injecting", "author_reply");
    expect(dropped).toHaveLength(1);
    expect(store.heldWakes(7).map((wake) => wake.payload)).not.toContain(
      "arrived while the batch was injecting",
    );

    accept();
    expect(await flush).toBe(5);
    expect(store.heldWakes(7)).toHaveLength(0);
    expect(store.recentEvents(20).some((event) => event.kind === "wake_ack_lost")).toBe(false);
  });

  it("joins a recovered author reply to its contiguous burst but never crosses another wake class", async () => {
    store.holdWake(
      7,
      "# Author reply — PR #7\n\nrecovered comment 201",
      "operator_recovered:wake:old-command",
    );
    store.holdWake(7, "# Author reply — PR #7\n\ncomment 202", "author_reply");
    store.holdWake(7, "recheck the pushed head", "recheck:push");
    store.holdWake(7, "# Author reply — PR #7\n\ncomment 203", "author_reply");
    let seq = 0;
    const durableDeps = {
      store,
      inject: async (pr: number, message: string) => {
        injected.push({ pr, message });
        const command = `cmd-${seq++}`;
        store.createSessionCommand({
          id: command,
          pr,
          session: `pr-${pr}`,
          kind: "wake",
          round_no: null,
          payload_sha256: "c".repeat(64),
          payload_path: `/state/${command}.md`,
          inject_path: `/inject/pr-${pr}/${command}.md`,
          next_check_at: new Date(Date.now() + 120_000).toISOString(),
        });
      },
    };

    expect(await flushHeldWakes(durableDeps, 7)).toBe(2);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.message).toContain("recovered comment 201");
    expect(injected[0]!.message).toContain("comment 202");
    expect(injected[0]!.message).not.toContain("recheck the pushed head");
    expect(store.heldWakes(7).map((wake) => wake.payload)).toEqual([
      "recheck the pushed head",
      "# Author reply — PR #7\n\ncomment 203",
    ]);
  });

  it("caps held wakes per PR, dropping the oldest with an event", async () => {
    store.startRound(7, "first", ["pass-baseline"], 75);
    for (let i = 0; i < MAX_HELD_WAKES + 2; i++)
      await wakeOrHold(deps(), 7, `m${i}`, "author_reply");
    const held = store.heldWakes(7);
    expect(held).toHaveLength(MAX_HELD_WAKES);
    expect(held[0]!.payload).toBe("m2"); // the two oldest were evicted
    expect(store.recentEvents(50).some((e) => e.kind === "wake_dropped")).toBe(true);
  });

  it("releases a failed oldest batch atomically and retries it before later messages", async () => {
    store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "a", "author_reply");
    await wakeOrHold(deps(), 7, "b", "author_reply");
    const failed = await flushHeldWakes(
      {
        store,
        inject: async () => {
          throw new Error("session dead");
        },
      },
      7,
    );
    expect(failed).toBe(0);
    expect(store.heldWakes(7).map((w) => [w.payload, w.attempts, w.claim_token])).toEqual([
      ["a", 1, null],
      ["b", 1, null],
    ]);

    expect(await flushHeldWakes(deps(), 7)).toBe(2);
    expect(injected).toHaveLength(1);
    expect(injected[0]!.message.indexOf("\na\n")).toBeLessThan(
      injected[0]!.message.indexOf("\nb\n"),
    );
    expect(store.heldWakes(7)).toHaveLength(0);
  });
});
