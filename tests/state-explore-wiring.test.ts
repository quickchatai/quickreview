// How `state_explore` reaches a lens, and only the lenses it is for.
//
// Three layers hold "the state-machine family, and nothing else":
//   - the build (`applyStateTools`, include.ts) puts the name on exactly the
//     STATE_FAMILY variants' tools lines of a PR build, strips it from every
//     other agent, and a scan or replay build carries none;
//   - the runner's gate (`stateLeafTools`, extensions/lens.ts, which every
//     route's LensRunConfig comes from) attaches the tool's factory only when
//     the agent is a family variant AND its own line names the tool or it
//     carries no allowlist at all;
//   - the extension itself refuses a target outside the session's cwd or a
//     malformed sha with a text result, never a throw, and keeps its memory
//     per session.
// The reader behind the tool (packages/pi-plugin/src/stateexplore.ts) is
// stubbed through the extension's io seam wherever a call would reach git.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionAPI,
  ExtensionFactory,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { createBashGuard } from "@quickchatai/pi-quickreview/extensions/bash-guard.js";
import { stateLeafTools } from "@quickchatai/pi-quickreview/extensions/lens.js";
import {
  STATE_EXPLORE_TOOL,
  createStateExplore,
  type ExploreTarget,
  type StateExploreConfig,
} from "@quickchatai/pi-quickreview/extensions/state-explore.js";
import type { ExploreIo } from "@quickchatai/pi-quickreview/src/stateexplore.js";
import {
  PASS_ADDENDA,
  PASS_TIERS,
  applyStateTools,
  buildAgents,
  configAddenda,
  identityVars,
  type BuiltAgent,
} from "@quickchatai/pi-quickreview/src/include.js";
import {
  loadBuiltAgents,
  type LensAgent,
} from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import { createLensRunner } from "@quickchatai/pi-quickreview/src/engine/lens/runlens.js";
import { STATE_FAMILY } from "@quickchatai/pi-quickreview/src/passes.js";
import { lensTuningAddenda, roundAgentModels } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { postingPolicyAddenda } from "@quickchatai/pi-quickreview/src/postingpolicy.js";
import type { PassTier } from "@quickchatai/pi-quickreview/src/types.js";
import { buildBenchAgents } from "../src/bench/runner.js";
import { loadConfig, type Config } from "../src/config.js";
import { buildScanAgents } from "../src/setup/scanbuild.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { createHostRig, useOfflineGuard, type HostRig } from "./pi-canary/harness.js";

useOfflineGuard();

const ROOT = join(import.meta.dirname, "..");
const cfg: Config = loadConfig(join(ROOT, "tests", "fixtures", "config.toml"));
const FAMILY_LINE = `read, bash, grep, ${STATE_EXPLORE_TOOL}`;

const toolsLine = (text: string): string | undefined => /^tools:[ \t]*(.*)$/m.exec(text)?.[1];
/** The pass a built variant's file name names (`<pass>--<tier>.md`). */
const passOf = (file: string): string => file.replace(/\.md$/, "").replace(/--.*$/, "");

const scratch = mkdtempSync(join(tmpdir(), "qcr-sm-explore-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Every built file in `dir`, as pass → [tools line of each variant]. */
function linesIn(dir: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const line = toolsLine(readFileSync(join(dir, f), "utf8")) ?? "";
    const pass = passOf(f);
    out.set(pass, [...(out.get(pass) ?? []), line]);
  }
  return out;
}

/** The VM's build, as wire.ts composes it. */
function buildVm(out: string): BuiltAgent[] {
  return buildAgents(join(ROOT, "agents"), out, {
    root: ROOT,
    tiers: cfg.models.tiers,
    riskPasses: cfg.models.risk_passes,
    validateTier: cfg.models.validate_tier,
    vars: identityVars(cfg),
    models: roundAgentModels(cfg),
    addenda: [
      ...PASS_ADDENDA,
      ...configAddenda(cfg.review),
      ...lensTuningAddenda(cfg.lenses),
      ...postingPolicyAddenda(cfg.posting),
    ],
  });
}

describe("the build grants state_explore to the state-machine family alone", () => {
  // The grant is the build's: the family's own seeds stay `read, bash, grep`.
  // MUTATION: add state_explore to the tools line of agents/pass-sm-stuck.md — fails.
  it("the family's seeds keep read, bash, grep", () => {
    for (const lens of STATE_FAMILY) {
      const seed = readFileSync(join(ROOT, "agents", `${lens}.md`), "utf8");
      expect(toolsLine(seed), lens).toBe("read, bash, grep");
    }
  });

  // MUTATION: return `frontmatter` unchanged from applyStateTools (include.ts) — fails.
  it(
    "on the vm and bench builds every family variant's line is exactly read, bash, grep, state_explore, and no other agent's names it",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const vm = join(scratch, "vm");
      const bench = join(scratch, "bench");
      buildVm(vm);
      buildBenchAgents(ROOT, cfg, bench);
      for (const dir of [vm, bench]) {
        const lines = linesIn(dir);
        // Non-vacuous: every family lens was built.
        for (const lens of STATE_FAMILY) expect(lines.has(lens), `${dir}: ${lens}`).toBe(true);
        for (const [pass, variants] of lines) {
          for (const line of variants) {
            if (STATE_FAMILY.includes(pass)) expect(line, pass).toBe(FAMILY_LINE);
            else
              expect(
                line.split(",").map((t) => t.trim()),
                pass,
              ).not.toContain(STATE_EXPLORE_TOOL);
          }
        }
      }
    },
  );

  // MUTATION: call applyStateTools on the scan branch of buildAgents' tools
  // step (include.ts) — the scan's family lines gain the tool; this fails.
  it(
    "a scan build and a replay (readOnlyLeaves) build carry no state_explore",
    { timeout: HEAVY_TIMEOUT_MS },
    () => {
      const scan = join(scratch, "scan");
      const replay = join(scratch, "replay");
      buildScanAgents(ROOT, scan, cfg);
      buildAgents(join(ROOT, "agents"), replay, {
        root: ROOT,
        readOnlyLeaves: true,
        riskPasses: [],
        validateTier: "light",
      });
      for (const dir of [scan, replay]) {
        const lines = linesIn(dir);
        expect(
          STATE_FAMILY.some((l) => lines.has(l)),
          `${dir}: a family variant is built`,
        ).toBe(true);
        for (const [pass, variants] of lines)
          for (const line of variants)
            expect(line, `${dir}: ${pass}`).not.toContain(STATE_EXPLORE_TOOL);
      }
    },
  );

  // MUTATION: drop the strip (`kept` = `listed`) in applyStateTools — the
  // pass-baseline case keeps the name; this fails.
  it("applyStateTools adds the name once to a family line and strips it from any other", () => {
    expect(applyStateTools("name: x\ntools: read, bash, grep\n", "pass-sm-stuck")).toBe(
      `name: x\ntools: ${FAMILY_LINE}\n`,
    );
    // A seed that already lists it gets it once, at the end.
    expect(
      applyStateTools(
        `name: x\ntools: read, ${STATE_EXPLORE_TOOL}, bash, grep\n`,
        "pass-sm-durable",
      ),
    ).toBe(`name: x\ntools: ${FAMILY_LINE}\n`);
    expect(
      applyStateTools(`name: x\ntools: read, ${STATE_EXPLORE_TOOL}, bash\n`, "pass-baseline"),
    ).toBe("name: x\ntools: read, bash\n");
    // pass-validate judges the family's findings; it never explores.
    expect(applyStateTools(`tools: read, State_Explore\n`, "pass-validate")).toBe("tools: read\n");
    // No line: no allowlist, which a grant must not narrow.
    expect(applyStateTools("name: x\n", "pass-sm-stuck")).toBe("name: x\n");
  });
});

describe("the runner's gate: a family name AND the agent's own allowlist, if it has one", () => {
  const agent = (name: string, tools: string[] | undefined): LensAgent => ({
    name,
    description: name,
    model: undefined,
    modelId: undefined,
    thinking: null,
    tools,
    body: "",
    filePath: `/agents/${name}.md`,
    origin: "built",
    overrides: null,
  });
  const gate = stateLeafTools("/work", "/usr/bin");

  // MUTATION: drop the STATE_FAMILY test from stateLeafTools (extensions/lens.ts) — fails.
  // MUTATION: drop the allowlist test from stateLeafTools — fails.
  // MUTATION: restore `(agent.tools ?? []).includes(…)` — the family variant
  // with no allowlist gets nothing, and this fails.
  it("gives a factory to a family variant whose line names the tool or that has no line, and to nothing else", () => {
    const withTool = ["read", "bash", "grep", STATE_EXPLORE_TOOL];
    for (const tier of PASS_TIERS)
      expect(gate(agent(`pass-sm-stuck--${tier}`, withTool)), tier).toHaveLength(1);
    // The name gate: a non-family lens whose line names the tool gets nothing.
    expect(gate(agent("pass-baseline--deep", withTool))).toEqual([]);
    expect(gate(agent("pass-validate--light", withTool))).toEqual([]);
    expect(gate(agent("pass-sm-common--standard", withTool))).toEqual([]);
    // A joined field is not a name.
    expect(gate(agent("pass-baseline+pass-sm-stuck--deep", withTool))).toEqual([]);
    // The allowlist gate: a family variant built without it gets nothing.
    expect(gate(agent("pass-sm-stuck--deep", ["read", "grep", "find", "ls"]))).toEqual([]);
    // No allowlist means every tool the harness gives, this one included —
    // for a family variant; a lens outside the family still gets nothing.
    expect(gate(agent("pass-sm-stuck--deep", undefined))).toHaveLength(1);
    expect(gate(agent("pass-baseline--deep", undefined))).toEqual([]);
  });

  // A profile layer's or a repository's own agents/pass-sm-*.md with no
  // `tools:` line is left alone by the build (no allowlist to narrow), so the
  // built family variant carries no line and the gate must still give it the
  // tool. The same file for a lens outside the family gives nothing.
  // MUTATION: restore `(agent.tools ?? []).includes(…)` in stateLeafTools — fails.
  it("a family agent file a profile layer serves with no tools line keeps the tool through the build", () => {
    const out = mkdtempSync(join(scratch, "no-line-"));
    const noLine = (text: string): string => text.replace(/^tools:.*\n/m, "");
    const own = new Set(["pass-sm-stuck.md", "pass-baseline.md"]);
    buildAgents(join(ROOT, "agents"), out, {
      root: ROOT,
      riskPasses: [],
      validateTier: "light",
      readFile: (p: string) => {
        const text = readFileSync(p, "utf8");
        return own.has(p.slice(p.lastIndexOf("/") + 1)) ? noLine(text) : text;
      },
    });
    const registry = loadBuiltAgents(out);
    const stuck = registry.get("pass-sm-stuck--light");
    const baseline = registry.get("pass-baseline--light");
    expect(stuck, "built").toBeDefined();
    expect(baseline, "built").toBeDefined();
    expect(stuck!.tools).toBeUndefined();
    expect(baseline!.tools).toBeUndefined();
    expect(gate(stuck!)).toHaveLength(1);
    expect(gate(baseline!)).toEqual([]);
    // Control: the shipped file keeps its line, which the build extends.
    expect(registry.get("pass-sm-events--light")!.tools).toContain(STATE_EXPLORE_TOOL);
  });

  // MUTATION: build the factory once in stateLeafTools and return it on every
  // call — two passes would share one factory; this fails.
  it("makes a fresh factory for each pass", () => {
    const a = agent("pass-sm-events--standard", ["read", STATE_EXPLORE_TOOL]);
    const [one] = gate(a);
    const [two] = gate(a);
    expect(one).toBeDefined();
    expect(one).not.toBe(two);
  });
});

describe("[runLens] a pass-sm session holds state_explore; no other lens does", () => {
  let rig: HostRig;
  let dir: string;
  let sessions: AgentSession[];

  beforeEach(async () => {
    rig = await createHostRig();
    dir = mkdtempSync(join(tmpdir(), "qcr-sm-explore-run-"));
    sessions = [];
    const real = rig.host.makeSession.bind(rig.host);
    vi.spyOn(rig.host, "makeSession").mockImplementation(async (spec) => {
      const s = await real(spec);
      sessions.push(s);
      return s;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rig.close();
    rmSync(dir, { recursive: true, force: true });
  });

  // MUTATION: return [] from stateLeafTools — the family's sessions lack the
  // tool; this fails. MUTATION: return the factory for every agent — the
  // impostor's session holds it; this fails.
  it(
    "over a default build of the real agents, and an impostor whose line names the tool",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const out = join(dir, "built");
      const tiers = Object.fromEntries(PASS_TIERS.map((t) => [t, "faux/faux-1"])) as Record<
        PassTier,
        string
      >;
      const built = buildAgents(join(ROOT, "agents"), out, {
        root: ROOT,
        tiers,
        riskPasses: [],
        validateTier: "light",
      });
      writeFileSync(
        join(out, "pass-impostor--light.md"),
        `---\nname: pass-impostor--light\ndescription: impostor\nmodel: faux/faux-1\ntools: read, ${STATE_EXPLORE_TOOL}\n---\nYou read code.\n`,
      );
      // One session per pass (its light variant): the family and every other lens.
      const names = [
        ...new Set(built.filter((b) => b.tier === "light").map((b) => b.name)),
        "pass-impostor--light",
      ];
      expect(names.filter((n) => STATE_FAMILY.includes(passOf(n)))).toHaveLength(
        STATE_FAMILY.length,
      );
      rig.faux.setResponses(names.map(() => () => fauxAssistantMessage("fine")));
      const runner = createLensRunner({
        host: rig.host,
        permits: 4,
        registry: loadBuiltAgents(out),
        cwd: dir,
        env: { PATH: process.env["PATH"], HOME: dir },
        bashGuard: createBashGuard({ sandboxRoot: dir, replay: false, secretDirs: [] }),
        leafTools: stateLeafTools(dir, process.env["PATH"] ?? ""),
        ledgerPath: join(dir, "round", "lens-ledger.jsonl"),
        sessionGapMs: 0,
      });
      for (const name of names) {
        const before = sessions.length;
        const { result } = await runner.run({ agent: name, task: "go" });
        expect(result.exitCode, `${name}: ${result.errorMessage ?? ""}`).toBe(0);
        const held = sessions[before]!.getAllTools().map((t) => t.name);
        if (STATE_FAMILY.includes(passOf(name))) expect(held, name).toContain(STATE_EXPLORE_TOOL);
        else expect(held, name).not.toContain(STATE_EXPLORE_TOOL);
      }
    },
  );
});

describe("the extension: refusals are text, memory is per session", () => {
  const SHA_A = "a".repeat(40);
  const SHA_B = "b".repeat(40);
  let cwd: string;
  let outside: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "qcr-sm-explore-cwd-"));
    outside = mkdtempSync(join(tmpdir(), "qcr-sm-explore-out-"));
    mkdirSync(join(cwd, "wt", "pr-1"), { recursive: true });
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  /** An io over an empty tree: every read answers nothing. */
  const emptyIo = (): ExploreIo => ({
    listHead: async () => [],
    readHead: async () => null,
    readBase: async () => null,
    diff: async () => [],
  });

  /** One session: the tool the factory registers on a fresh pi. */
  function session(factory: ExtensionFactory): ToolDefinition {
    const tools: ToolDefinition[] = [];
    const pi = { registerTool: (t: ToolDefinition) => tools.push(t) } as unknown as ExtensionAPI;
    void factory(pi);
    expect(tools.map((t) => t.name)).toEqual([STATE_EXPLORE_TOOL]);
    return tools[0]!;
  }

  const call = async (tool: ToolDefinition, params: Record<string, unknown>): Promise<string> => {
    const r = await tool.execute("c", params as never, undefined, undefined, undefined as never);
    const first = r.content[0];
    return first !== undefined && first.type === "text" ? first.text : "";
  };

  /** A config whose io and check are recorded. `refuse` names worktrees the check refuses. */
  function recorded(refuse: string[] = []) {
    const made: ExploreTarget[] = [];
    const checked: string[] = [];
    const config: StateExploreConfig = {
      cwd,
      path: "",
      makeIo: (t) => {
        made.push(t);
        return emptyIo();
      },
      check: (_cwd, worktree, base, head) => {
        checked.push(worktree);
        return refuse.includes(worktree)
          ? { ok: false, refusal: "refused: not this one" }
          : { ok: true, worktree, base, head };
      },
    };
    return { made, checked, config };
  }

  // The real check (checkExploreTarget), no seam: a worktree outside cwd.
  // MUTATION: skip the check in stateExploreTool (extensions/state-explore.ts)
  // — the io is built over the outside dir; this fails.
  it("refuses a worktree outside the session's cwd, without throwing and without a reader", async () => {
    const made: ExploreTarget[] = [];
    const tool = session(
      createStateExplore({
        cwd,
        path: "",
        makeIo: (t) => {
          made.push(t);
          return emptyIo();
        },
      }),
    );
    const text = await call(tool, {
      action: "anchors",
      worktree: outside,
      base: SHA_A,
      head: SHA_B,
    });
    expect(text).toMatch(new RegExp(`^${STATE_EXPLORE_TOOL} refused: `));
    expect(made).toEqual([]);
  });

  // MUTATION: drop the SHA_RE tests from readTarget — the check is asked; this fails.
  it("refuses a malformed sha or a relative worktree before any check", async () => {
    const { checked, made, config } = recorded();
    const tool = session(createStateExplore(config));
    const wt = join(cwd, "wt", "pr-1");
    for (const bad of [
      { worktree: wt, base: "abc123", head: SHA_B },
      { worktree: wt, base: SHA_A, head: `${SHA_B}; rm -rf /` },
      { worktree: wt, base: "--output=x", head: SHA_B },
      { worktree: "wt/pr-1", base: SHA_A, head: SHA_B },
    ]) {
      const text = await call(tool, { action: "anchors", ...bad });
      expect(text, JSON.stringify(bad)).toMatch(new RegExp(`^${STATE_EXPLORE_TOOL} refused: `));
    }
    expect(checked).toEqual([]);
    expect(made).toEqual([]);
    // MUTATION: echo the lowercased id — the refusal says "head" and this fails.
    expect(
      await call(tool, { action: "anchors", worktree: wt, base: "HEAD", head: SHA_B }),
    ).toContain("(got HEAD)");
  });

  it("refuses a first call with no target, and an unknown action or a bad line", async () => {
    const { config } = recorded();
    const tool = session(createStateExplore(config));
    expect(await call(tool, { action: "anchors" })).toMatch(
      /refused: the first call names worktree/,
    );
    const target = { worktree: join(cwd, "wt", "pr-1"), base: SHA_A, head: SHA_B };
    expect(await call(tool, { action: "run", ...target })).toMatch(/refused: action must be/);
    expect(await call(tool, { action: "exits", file: "a.c", line: 0, ...target })).toMatch(
      /refused: line must be/,
    );
  });

  // MUTATION: drop the `memory.target === undefined || …` reuse and re-check
  // every call — `checked` grows to 2; this fails.
  it("remembers the target for the session's later calls; a change is checked again, a refused change keeps the old", async () => {
    const wt = join(cwd, "wt", "pr-1");
    const other = join(cwd, "wt", "pr-2");
    const { checked, made, config } = recorded([other]);
    const tool = session(createStateExplore(config));
    const first = await call(tool, {
      action: "writes",
      name: "state",
      worktree: wt,
      base: SHA_A,
      head: SHA_B,
    });
    expect(first).not.toMatch(/^state_explore (refused|failed)/);
    const second = await call(tool, { action: "reads", name: "state" });
    expect(second).not.toMatch(/^state_explore (refused|failed)/);
    expect(checked).toEqual([wt]);
    expect(made).toEqual([
      { worktree: wt, base: SHA_A, head: SHA_B },
      { worktree: wt, base: SHA_A, head: SHA_B },
    ]);
    expect(await call(tool, { action: "anchors", worktree: other })).toMatch(
      /^state_explore refused: not this one$/,
    );
    expect(checked).toEqual([wt, other]);
    expect(await call(tool, { action: "anchors" })).not.toMatch(/^state_explore (refused|failed)/);
    expect(made.map((t) => t.worktree)).toEqual([wt, wt, wt]);
  });

  // runStateExplore closes the reader it is given, so a reader kept across
  // calls answers nothing from the second call on.
  // MUTATION: build the reader once per target (keep it in the session's
  // memory) instead of once per call — the second call reads a closed
  // reader; this fails.
  it("every call reads through a reader of its own, never one an earlier call closed", async () => {
    let closedReads = 0;
    const tool = session(
      createStateExplore({
        cwd,
        path: "",
        makeIo: () => {
          let closed = false;
          const io = emptyIo();
          return {
            ...io,
            listHead: async () => {
              if (closed) closedReads += 1;
              return [];
            },
            diff: async () => {
              if (closed) closedReads += 1;
              return [];
            },
            close: async () => {
              closed = true;
            },
          };
        },
        check: (_cwd, worktree, base, head) => ({ ok: true, worktree, base, head }),
      }),
    );
    const target = { worktree: join(cwd, "wt", "pr-1"), base: SHA_A, head: SHA_B };
    await call(tool, { action: "anchors", ...target });
    await call(tool, { action: "writes", name: "state" });
    await call(tool, { action: "anchors" });
    expect(closedReads).toBe(0);
  });

  // MUTATION: drop the io.verify() step in stateExploreTool — the call runs
  // over ids that are not commits and the target is remembered; this fails.
  it("refuses a target whose ids are not commits, closes that reader and remembers nothing", async () => {
    let closes = 0;
    const tool = session(
      createStateExplore({
        cwd,
        path: "",
        makeIo: () => ({
          ...emptyIo(),
          verify: async () => "refused: `base` aaaaaaaaaaaa does not resolve to a commit",
          close: async () => {
            closes += 1;
          },
        }),
        check: (_cwd, worktree, base, head) => ({ ok: true, worktree, base, head }),
      }),
    );
    const target = { worktree: join(cwd, "wt", "pr-1"), base: SHA_A, head: SHA_B };
    expect(await call(tool, { action: "anchors", ...target })).toMatch(
      /^state_explore refused: `base` aaaaaaaaaaaa does not resolve/,
    );
    expect(closes).toBe(1);
    expect(await call(tool, { action: "anchors" })).toMatch(
      /refused: the first call names worktree/,
    );
  });

  // MUTATION: hoist `memory` out of stateExploreTool into createStateExplore's
  // closure — the second session sees the first's target; this fails.
  it("two sessions of one factory share no memory", async () => {
    const { config } = recorded();
    const factory = createStateExplore(config);
    const a = session(factory);
    const b = session(factory);
    const target = { worktree: join(cwd, "wt", "pr-1"), base: SHA_A, head: SHA_B };
    expect(await call(a, { action: "anchors", ...target })).not.toMatch(/^state_explore refused/);
    expect(await call(b, { action: "anchors" })).toMatch(/refused: the first call names worktree/);
  });

  // MUTATION: remove the try/catch around execute's body — the call rejects; this fails.
  it("a check that throws is a text result, never a throw", async () => {
    const tool = session(
      createStateExplore({
        cwd,
        path: "",
        makeIo: emptyIo,
        check: () => {
          throw new Error("boom");
        },
      }),
    );
    const text = await call(tool, {
      action: "anchors",
      worktree: join(cwd, "wt", "pr-1"),
      base: SHA_A,
      head: SHA_B,
    });
    expect(text).toBe(`${STATE_EXPLORE_TOOL} failed: boom`);
  });
});
