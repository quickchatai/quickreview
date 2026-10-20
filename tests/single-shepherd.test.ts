// The single-shepherd invariant (docs/single-shepherd-invariant.md): one main
// pi per PR owns the review, the daemon only nudges, agents are launched only
// by the round's engine (the planned discovery wave) and by that one pi (the
// `subagent` / `launch_plan` tools on the tmux bot, the `lens` / `lens_wave`
// tools on engine routes), lenses are leaves, and the main pi is never given
// two instructions at once, bar an operator's steer.
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
import { checkBashCommand } from "../extensions/cli/bash-guard-ambient.js";
import { COMPANION_DEFAULTS, resolveCompanionPaths, type Config } from "../src/config.js";
import { LEAF_MEMORY_TOOLS, buildAgents, stripAgentSpawnTools } from "../src/include.js";
import { PrSessionLifecycle, prSessionName } from "../src/pr-session-lifecycle.js";
import { isSandboxSession } from "../src/sessions.js";
import { MAX_HELD_WAKES, StateStore } from "../src/state.js";
import { CompanionLifecycle } from "../src/tui/companion.js";
import { flushHeldWakes, pauseDefersAllHeldWakes, wakeOrHold } from "../src/wakes.js";
import type { WorktreeManager } from "../src/worktrees.js";
import { runtimeSdkImporters } from "./helpers/engine-fences.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

// ---- S1/S2: the daemon spawns one session kind and launches no agent ------

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

  it("S1: only sessions.ts and the replay may birth a pi session", () => {
    // sessions.ts owns the one DAEMON-OWNED kind. replay.ts is an
    // operator one-shot, not daemon topology: it runs only under an explicit
    // `qcr` invocation, spawns a session whose name is outside the
    // `pr-<n>` namespace (so `adopt()` can never pick one up —
    // pinned in tests/replay.test.ts), and kills it before returning. Its
    // session owns no PR, holds no gate and posts nothing; its whole contract
    // is "read a scratch tree, write one JSON file".
    const offenders = srcFiles(src)
      .filter((f) => !["sessions.ts", "replay.ts"].includes(f.slice(f.lastIndexOf("/") + 1)))
      .filter((f) => /\bspawnSession\s*\(/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  it("S1: the session namespace is exactly pr-<n>", () => {
    expect(isSandboxSession("pr-5263")).toBe(true);
    for (const name of [
      "overseer",
      "pass-security--sol-high",
      "pr-5263-pass",
      "companion",
      "reviewer",
    ]) {
      expect(isSandboxSession(name), name).toBe(false);
    }
  });

  // A PR's OpenViking session shares the PR session's NAME and is not
  // a session in this invariant's sense: it is a row in the memory store that
  // the daemon creates and deletes over HTTP — nothing schedules it, nothing
  // runs in it, no pi process is attached to it, and it never appears in tmux.
  // The one daemon-owned pi session kind is still exactly `pr-<n>`.
  it("S1: an OpenViking session is a store object, not a daemon-owned pi session", async () => {
    const dir = mkdtempSync(join(tmpdir(), "shepherd-ov-"));
    try {
      const live = new Set<string>();
      const ov: string[] = [];
      const lifecycle = new PrSessionLifecycle({
        cfg: {
          github: { repo: "o/n" },
          pi: { version: "0.84.1", session_dir: "state/pi-sessions" },
        } as unknown as Config,
        root: dir,
        worktrees: {} as unknown as WorktreeManager,
        host: {
          liveSessions: async () => [...live],
          provenGone: async (pr) => !live.has(prSessionName(pr)),
          killConfirmed: async () => true,
          stop: async () => undefined,
          reuseLive: async () => undefined,
          spawn: async (pr) => {
            live.add(prSessionName(pr));
            return prSessionName(pr);
          },
        },
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

      await lifecycle.ensureSession(5263, "t", "wt/pr-5263");
      // One pi session was born; the OpenViking session was CREATED, not spawned.
      expect([...live]).toEqual(["pr-5263"]);
      expect(ov).toEqual(["create pr-5263"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("S2: only pisdk.ts and the extension factories import the pi SDK at runtime", () => {
    // The SDK is the engine's session host, not a daemon facility: the daemon
    // never reaches it, and runLens gets its sessions from PiHost.makeSession
    // rather than importing the SDK itself. Type-only imports (erased at
    // build) are free; extensions/ are the factory modules pi loads. The scan
    // and its planted cases are in tests/fences-engine.test.ts.
    const offenders = runtimeSdkImporters(join(import.meta.dirname, "..")).filter(
      (f) => f !== "src/engine/pisdk.ts" && !f.startsWith("extensions/"),
    );
    expect(offenders).toEqual([]);
  });

  it("CLAUDE.md rule 9 is the ratified text (D9, with the answer worker's stage (i), P8.17)", () => {
    // Rule text changes only by the owner's ratification, so the test pins it
    // verbatim (whitespace folded: CLAUDE.md wraps it). The same words open
    // docs/single-shepherd-invariant.md's amendment.
    const RATIFIED =
      "[private rule text removed]";
    const text = readFileSync(join(import.meta.dirname, "..", "CLAUDE.md"), "utf8");
    const start = text.indexOf("\n9. ");
    const end = text.indexOf("\n10. ", start);
    expect(start).toBeGreaterThan(-1);
    const rule = text
      .slice(start + 4, end)
      .replace(/\s+/g, " ")
      .trim();
    expect(rule).toBe(RATIFIED);
    const doc = readFileSync(
      join(import.meta.dirname, "..", "docs", "single-shepherd-invariant.md"),
      "utf8",
    );
    // (whitespace folded: the doc wraps it, and the amendment breaks a line inside the names)
    const folded = doc.replace(/\s+/g, " ");
    expect(folded).toContain("Exactly two launchers");
    expect(folded).toContain("`lens` / `lens_wave`");
  });

  it("S2: no daemon module invokes pi outside the session manager", () => {
    // sessions.ts owns the daemon's pi argv. tui/companion.ts is the COMPANION boundary — a
    // local container on the owner's PC that never reaches GitHub or the gate
    // (CLAUDE.md hard rule 8), so its own pi argv is not a daemon spawn.
    // bench/runner.ts is the AACR-Bench sandbox's one-shot `pi -p` round: it
    // runs only inside the qcr-bench image (no daemon, no gate, no scripts/,
    // no credential), under a `bench-<id>` name no adopt() can match, and the
    // process exits when its round settles.
    // setup/caserunner.ts is the companion's survey/scan case
    // runner: it runs only inside the companion container (extensions/
    // setup.ts, never the daemon — the check below pins that no daemon module
    // imports src/setup/), and each spawn is a `-p --no-session -ne` leaf
    // (bash-guard the one extension) with read-only tools, not a session.
    const allowed = ["sessions.ts", "companion.ts"];
    // scanbox.ts is the scan sandbox: its pi runs in a throwaway container
    // from the companion image (`qcr scan login` interactively, the doctor's
    // one-shot `-p --no-session --no-extensions` probe), or — the doctor's
    // probe with `[scan] sandbox = "host"` — the same one-shot leaf on the
    // operator's machine. No daemon module imports it (pinned below).
    // reviewcli.ts is `qcr review`: the operator's own terminal, the shared
    // one-shot runner (oneshot.ts) with a pi binary override. Only cli.ts
    // imports it (dynamically); no daemon module does.
    // opencli.ts is `qcr open` and engine/debugpi.ts is `qcr review --debug-pi`:
    // the operator's own terminal, pi on its interactive UI over a finished or a
    // starting round (P5.9). Only cli.ts and reviewcli.ts import them (dynamically).
    // takeoverpi.ts is the pane side of the takeover lease (P8.13, D27): the operator's own
    // interactive pi on a PR's real session, in tmux `takeover-pr-<n>`, started by path by
    // the lease's manager (src/takeover.ts) on the operator's `takeover` command. It is not
    // a scheduled agent: it holds the session's lease, so no worker runs beside it, it has
    // the read tools only, and it posts nothing. No daemon module imports it.
    // debugroundpi.ts is the pane side of the bot's debug round (P8.13b, D38): the PR's own
    // round, delivered to an interactive pi in tmux `debug-pr-<n>` by the lease's manager
    // (src/debuground.ts) in a worker's place, on the operator's `debug-round` command. It is
    // the PR's main session, not a second agent: the lease keeps every worker out, the round
    // is the command's own (one capability, one generation), and it posts through the daemon's
    // one gate. No daemon module imports it.
    const allowedPaths = [
      "/src/oneshot.ts",
      "/src/reviewcli.ts",
      "/src/opencli.ts",
      "/src/engine/debugpi.ts",
      "/src/takeoverpi.ts",
      "/src/debugroundpi.ts",
      "/src/bench/runner.ts",
      "/src/setup/caserunner.ts",
      "/src/scanbox.ts",
    ];
    const offenders = srcFiles(src)
      .filter((f) => !allowed.includes(f.slice(f.lastIndexOf("/") + 1)))
      .filter((f) => !allowedPaths.some((p) => f.endsWith(p)))
      .filter((f) => /["'`]pi["'`]\s*,|piBin|--no-session/.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
    // The case runner's allowance holds only while no daemon module can reach
    // it: src/setup/ is imported from src/setup/ and the companion's
    // extension — with leaf exceptions: setup/history.js (the TUI's
    // `qcr history pull` needs the digest's file name),
    // setup/stage2request.js (the TUI's stage-2 start click reads the
    // proposal and writes the request), three for the operator's
    // machine — pins.js (the TUI marks proposed pins),
    // configcommit.js (the TUI and `qcr setup commit` carry out the profile
    // commits setup asked for) and profile.js (`qcr setup validate`, the
    // daemon's own loaders over a profile) — retunelog.js (the deploy tab
    // says which post-scan re-tune is not deployed) and scanreport.js (the [8]
    // scan tab reads the run record and the findings store, and asks for a
    // stop) and scanlease.js (the scan tab reads the driver lease). Each leaf may reach the rest of
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
      "scanlease.js",
    ];
    // One operator entry point reaches the whole of src/setup/: scancli.ts,
    // `qcr scan` — the companion's scan tools as a CLI verb, driving the
    // case runner in the operator's own one-shot process (as the companion
    // drives it in its container). It holds only while nothing but the CLI's
    // dispatch reaches it, which the check after this one pins.
    // src/engine/caserunner-sdk.ts is the same runner's SDK twin (P5.7): it
    // reads the leaf's agent file and event stream with the process runner's
    // own helpers, so it reaches setup/caserunner.js at runtime. Only
    // scancli.ts loads it (on demand, in the detached driver), pinned below.
    const operatorEntries = ["/src/scancli.ts", "/src/engine/caserunner-sdk.ts"];
    const reachesScanCli = srcFiles(src)
      .filter((f) => !f.endsWith("/src/cli.ts"))
      .filter((f) => /["'][^"']*\/scancli\.js["']/.test(readFileSync(f, "utf8")));
    expect(reachesScanCli).toEqual([]);
    // The scan sandbox's pi allowance above holds only while `qcr scan` is
    // the one module that reaches it.
    const reachesSdkLeaves = srcFiles(src)
      .filter((f) => !f.endsWith("/src/scancli.ts"))
      .filter((f) => /["'][^"']*\/caserunner-sdk\.js["']/.test(readFileSync(f, "utf8")));
    expect(reachesSdkLeaves).toEqual([]);
    const reachesScanBox = srcFiles(src)
      .filter((f) => !f.endsWith("/src/scancli.ts"))
      .filter((f) => /["'][^"']*\/scanbox\.js["']/.test(readFileSync(f, "utf8")));
    expect(reachesScanBox).toEqual([]);
    const reachesSetup = srcFiles(src)
      .filter((f) => !f.includes("/src/setup/"))
      .filter((f) => !operatorEntries.some((p) => f.endsWith(p)))
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
    // The handler hands the reply to `serveAuthorReply` (exported so it can be
    // driven directly) and does nothing else with it.
    expect(block).toContain("serveAuthorReply(");
    expect(block).not.toMatch(/await\s+hooks\.inject\(/);
    const fnStart = text.indexOf("export async function serveAuthorReply(");
    expect(fnStart).toBeGreaterThan(-1);
    const fn = text.slice(fnStart, text.indexOf("\n}\n", fnStart));
    expect(fn).toContain("wakeOrHold(");
    expect(fn).not.toMatch(/await\s+(?:deps\.|hooks\.)?inject\(/);
    // The reply is claimed before the wake: a failed injection must hold it,
    // never drop it.
    expect(fn).toContain("holdOnFailure: true");
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
   * The assertion above greps for a CALL SHAPE, and the one
   * module that actually reaches a `pr-<n>` session from outside the daemon
   * does not use it: `src/tui/msg.ts` writes the inject FILE itself, over ssh,
   * with `docker exec … mv … inject/<session>/<name>.md`. The regex above
   * cannot see that.
   *
   * This is the fence for the OTHER spelling: constructing an inject path.
   * It names the file rather than the call, so a future module that reaches a
   * PR session by writing the drop-box directly fails here even if it never
   * calls `.inject(pr, …)`.
   *
   * The allowlist is the point. `msg.ts` is a sanctioned operator-initiated
   * exception ("the board is read-only over ssh with exactly two
   * exceptions", the quick-message box being the first), and an exception the
   * suite cannot see is indistinguishable from an oversight, so it is written
   * down here with what makes it legal.
   */
  it(
    "only the sanctioned writers construct a session's inject drop-box path",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
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
          file: "src/companioninbox.ts",
          why: "the companion inbox (inject/companion-inbox/): a directory of alert items the companion's TUI pulls and acks, never a session's drop-box and never delivered to a pi session (the overseer it replaced is retired)",
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
          file: "src/tui/remote.ts",
          why: "names the bot's companion inbox (inject/companion-inbox/) for the TUI's pull and ack of its items — never a session's drop-box and never a pr-<n> directory (rule 8)",
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
        {
          file: "src/usage.ts",
          why:
            "the exec-policy audit NAMES the `inject` dir as one of the protected path components a pattern write " +
            "target is tried against, so a session's write onto a wake-delivery file is flagged after the fact. " +
            "It reads transcripts only and never builds a path into the inject tree.",
        },
        {
          file: "src/archive/prfiles.ts",
          why:
            "the closed-PR archiver's inventory (shared by the plan and the archive pass) LISTS " +
            "inject/pr-<n>/ of closed PRs: an undelivered top-level wake holds the PR; the consumed .done/.terminal " +
            "files, quarantines and terminal-row leftovers are archived and — only after they verify and the " +
            "synchronous eligibility re-check passes — removed. It never puts a wake there; recorded because it " +
            "constructs the path.",
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
      // sessions.ts uses. A fence that caught only the first spelling would
      // pass a rogue writer using the second: a detector tuned to today's call
      // sites is the same false all-clear as grepping for a name instead of a
      // reader.
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
    },
  );
});

// ---- S3: passes are leaves ------------------------------------------------

describe("stripAgentSpawnTools", () => {
  it("drops agent-spawning tools and keeps the read-only ones", () => {
    expect(stripAgentSpawnTools("tools: read, bash, subagent, grep\n")).toBe(
      "tools: read, bash, grep\n",
    );
    expect(stripAgentSpawnTools("tools: read, Task, agent, glob\n")).toBe("tools: read, glob\n");
    expect(stripAgentSpawnTools("tools: read, launch_plan, grep\n")).toBe("tools: read, grep\n");
  });

  it("drops the engine routes' lens tools (D3) the same way", () => {
    expect(stripAgentSpawnTools("tools: read, lens, grep\n")).toBe("tools: read, grep\n");
    expect(stripAgentSpawnTools("tools: read, lens_wave, grep\n")).toBe("tools: read, grep\n");
    expect(stripAgentSpawnTools("tools: read, Lens_Wave, lens, bash\n")).toBe(
      "tools: read, bash\n",
    );
    expect(stripAgentSpawnTools("name: x\ntools: lens, lens_wave\n")).not.toContain("tools:");
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

  it("strips the engine routes' lens tools a seed might grow (D3)", () => {
    const src = join(dir, "agents");
    const out = join(dir, "built");
    mkdirSync(src, { recursive: true });
    writeFileSync(
      join(src, "pass-baseline.md"),
      "---\nname: pass-baseline\ntools: read, lens, bash, lens_wave, grep\nmodel: openai/x\n---\n\nbody\n",
    );
    for (const agent of buildAgents(src, out, { riskPasses: [], validateTier: "terra-med" })) {
      const text = readFileSync(agent.output, "utf8");
      const tools = /^tools:[ \t]*(.*)$/m
        .exec(text)![1]!
        .split(",")
        .map((t) => t.trim());
      expect(tools).toEqual(expect.arrayContaining(["read", "bash", "grep"]));
      expect(tools).not.toContain("lens");
      expect(tools).not.toContain("lens_wave");
    }
  });

  // Leaves may LOOK THINGS UP and may not write. Two layers — this
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
      expect(text).toContain("**You have no write tool**");
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
// The native extension's children spawn WITHOUT per-spawn argv
// extensions and load only the global settings.json list. The glue therefore
// rides argv (pinned in tests/sessions.test.ts / tests/tui-companion.test.ts),
// and the global registration lists in BOTH container boots must never grow a
// subagents entry — that is the structural guarantee that a leaf cannot fan
// out, and it holds no matter what a frontmatter says.
describe("subagents glue is never registered globally", () => {
  const root = join(import.meta.dirname, "..");
  // The release image's entrypoint (P9.5) registers no global extension at all.
  it("docker/entrypoint.sh: the global extension list is empty", () => {
    const text = readFileSync(join(root, "docker/entrypoint.sh"), "utf8");
    expect(text).not.toContain("QCR_PI_REQUIRE_EXT");
    expect(text).not.toContain("settings.extensions.push");
  });
  for (const file of ["docker/daemon/entrypoint.sh"]) {
    it(`${file}: the global extension list carries no subagent loader`, () => {
      const text = readFileSync(join(root, file), "utf8");
      const wanted = /const wanted = \[([\s\S]*?)\];/.exec(text)?.[1] ?? "";
      const paths = [...wanted.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
      expect(paths.length).toBeGreaterThan(0);
      for (const p of paths) {
        expect(p, `${p} must not hand children an agent launcher or memory`).not.toMatch(
          /subagent|openviking|register-lens|extensions\/lens/,
        );
      }
    });
  }

  // extensions/lens.ts hosts SDK lens sessions in an interactive pi (a debug
  // round, the companion since P7.8). The tmux bot runs the native pair
  // through extensions/subagents.ts and never loads it: the argv lists that
  // start its sessions and the bench's must not name it.
  for (const file of ["src/sessions.ts", "src/bench/runner.ts"]) {
    it(`${file}: the tmux bot's and the bench's pi never load extensions/lens.ts`, () => {
      const text = readFileSync(join(root, file), "utf8");
      expect(text).not.toMatch(/extensions\/lens\b|["']lens\.ts["']/);
    });
  }

  it("src/tui/companion.ts: the companion loads our lens tool, not the example-subagent glue", () => {
    const argv = new CompanionLifecycle(
      resolveCompanionPaths({ ...COMPANION_DEFAULTS, repo_dir: "/r" }, "/r"),
      async () => ({ ok: true, stdout: "", stderr: "", code: 0 }),
      { HOME: "/h" },
      () => {},
      { exists: () => false, read: () => undefined, mode: () => undefined },
    ).piArgv();
    expect(argv).toContain("/opt/qcr/extensions/cli/lens.ts");
    expect(argv.filter((a) => /subagents?\.ts$|register-lens/.test(a))).toEqual([]);
  });
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

  // With no round and no command, a NEW wake must not inject straight past
  // older held wakes still waiting for the stranded sweep.
  it(
    "a new wake never overtakes an existing held backlog",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const id = store.startRound(7, "first", ["pass-baseline"], 75);
      await wakeOrHold(deps(), 7, "older reply", "author_reply");
      store.finishRound(id, "APPROVE", null, null);
      // The round is over, the backlog not yet flushed; a newer reply arrives.
      // It goes out with the backlog, and says so.
      expect(await wakeOrHold(deps(), 7, "newer reply", "author_reply")).toBe("injected");

      // Both go out oldest-first as one burst — never the newer one alone.
      expect(injected).toHaveLength(1);
      const burst = injected[0]!.message;
      expect(burst.indexOf("older reply")).toBeGreaterThan(-1);
      expect(burst.indexOf("older reply")).toBeLessThan(burst.indexOf("newer reply"));
      expect(store.heldWakes(7)).toHaveLength(0);
    },
  );

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

  // The daemon claims an author message BEFORE waking, so an injection that
  // fails before any command exists must hold the wake: dropped, the claim
  // would refuse every redelivery and the reply would never be answered.
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

  // The claim is taken before the wake, and the injection can wait on a
  // session rebirth: a process exit inside that wait must leave a held row
  // for the stranded-wake sweep, never a claim with nothing behind it.
  it("holdOnFailure persists the wake before the injection is awaited", async () => {
    let release!: () => void;
    const slow = {
      store,
      inject: (pr: number, message: string) =>
        new Promise<void>((resolve) => {
          release = () => {
            injected.push({ pr, message });
            resolve();
          };
        }),
    };
    const pending = wakeOrHold(slow, 7, "answer me", "author_reply", { holdOnFailure: true });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual(["answer me"]);
    release();
    expect(await pending).toBe("injected");
    expect(injected).toEqual([{ pr: 7, message: "answer me" }]);
    expect(store.heldWakes(7)).toHaveLength(0);
  });

  // A pause stops a PR's review work, so it defers a recheck nudge; it stops
  // no other wake. An author reply arriving behind a deferred recheck is
  // delivered while the pause stands; the recheck goes after the resume.
  it("a pause defers only the recheck: an author reply behind it is delivered while paused", async () => {
    store.pausePr(7, { issuer: "operator", expires_at: null }, "hold");
    expect(
      await wakeOrHold(deps(), 7, "ci question", "recheck:ci", { deferWhilePaused: true }),
    ).toBe("held");
    expect(injected).toHaveLength(0);
    await wakeOrHold(deps(), 7, "author reply", "author_reply", { holdOnFailure: true });
    expect(injected.map((w) => w.message)).toEqual(["author reply"]);
    expect(store.heldWakes(7).map((w) => w.reason)).toEqual(["recheck:ci"]);
    // Still paused: a flush leaves the recheck where it is, and the
    // stranded-wake sweep has nothing to deliver.
    expect(await flushHeldWakes(deps(), 7)).toBe(0);
    expect(pauseDefersAllHeldWakes(store, 7)).toBe(true);
    store.resumePr(7, "operator");
    expect(pauseDefersAllHeldWakes(store, 7)).toBe(false);
    expect(await flushHeldWakes(deps(), 7)).toBe(1);
    expect(injected.map((w) => w.message)).toEqual(["author reply", "ci question"]);
    expect(store.heldWakes(7)).toHaveLength(0);
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

  // A round end that awaited long enough for the PR's NEXT round
  // to be dispatched must not flush its held wakes into that round. An acked
  // round command holds no session slot, so the slot check cannot see it.
  // MUTATION: drop the `hasRunningRound` check in flushHeldWakes — red.
  it("never flushes into a round already running — the wakes wait for its end", async () => {
    const first = store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "held during round 1", "author_reply");
    store.finishRound(first, "APPROVE", null, null);
    const next = store.startRound(7, "re_review", ["pass-baseline"], 75);
    expect(store.blockingSessionCommand("pr-7")).toBeFalsy();

    expect(await flushHeldWakes(deps(), 7)).toBe(0);
    expect(injected).toHaveLength(0);
    expect(store.heldWakes(7).map((w) => w.payload)).toEqual(["held during round 1"]);

    store.finishRound(next, "APPROVE", null, null);
    expect(await flushHeldWakes(deps(), 7)).toBe(1);
    expect(injected).toHaveLength(1);
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

    // Author replies sit outside the cap — the leased batch is
    // never evicted and does not crowd out newcomers either: an author reply
    // and an ordinary wake arriving meanwhile are both held.
    expect(store.holdWake(7, "a ledger nudge arrived meanwhile", "ledger_stale")).toEqual([]);
    expect(store.holdWake(7, "arrived while the batch was injecting", "author_reply")).toEqual([]);

    accept();
    // The batch of five, then (this fake's inject holds no slot) the two
    // newcomers in arrival order — nothing was lost on the way.
    expect(await flush).toBe(7);
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

  it("caps held ordinary wakes per PR, dropping the oldest with an event", async () => {
    store.startRound(7, "first", ["pass-baseline"], 75);
    for (let i = 0; i < MAX_HELD_WAKES + 2; i++)
      await wakeOrHold(deps(), 7, `m${i}`, "ledger_stale");
    const held = store.heldWakes(7);
    expect(held).toHaveLength(MAX_HELD_WAKES);
    expect(held[0]!.payload).toBe("m2"); // the two oldest were evicted
    const dropped = store.recentEvents(50).filter((e) => e.kind === "wake_dropped");
    expect(dropped).toHaveLength(2);
    // The event names what went, not only what arrived.
    expect(JSON.parse(dropped[0]!.payload!)).toMatchObject({
      reason: "ledger_stale",
      dropped_reasons: ["ledger_stale"],
    });
  });

  it("releases a failed oldest batch atomically and retries it before later messages", async () => {
    const id = store.startRound(7, "first", ["pass-baseline"], 75);
    await wakeOrHold(deps(), 7, "a", "author_reply");
    await wakeOrHold(deps(), 7, "b", "author_reply");
    store.finishRound(id, "APPROVE", null, null); // a flush runs at round end
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

// A build whose leaves run
// without memory (the bench) carries neither the two memory tools nor the
// memory rule that describes them.
describe("buildAgents — memory off", () => {
  it("drops the memory tools and the memory rule; default builds keep both", () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-nomem-"));
    try {
      const src = join(dir, "agents");
      mkdirSync(src, { recursive: true });
      writeFileSync(
        join(src, "pass-baseline.md"),
        "---\nname: pass-baseline\ntools: read, grep\n---\n\nbody\n",
      );
      const off = buildAgents(src, join(dir, "off"), {
        riskPasses: [],
        validateTier: "terra-med",
        memory: false,
      });
      const on = buildAgents(src, join(dir, "on"), { riskPasses: [], validateTier: "terra-med" });
      const offText = readFileSync(off[0]!.output, "utf8");
      const onText = readFileSync(on[0]!.output, "utf8");
      expect(offText).not.toContain("viking_");
      expect(offText).not.toContain("## Memory: two read-only tools");
      expect(onText).toContain("viking_search");
      expect(onText).toContain("## Memory: two read-only tools");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
