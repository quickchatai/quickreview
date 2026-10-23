// The lens agent registry (packages/pi-plugin/src/engine/lens/registry.ts) loads the built
// agents with the name / model / tools pi's example subagent parser gives.
//
// The example (examples/extensions/subagent/agents.ts) is imported HERE ONLY,
// when a pi 1.4.0 install can be found (QCR_PI_PACKAGE_DIR, or the package
// resolved from the repo). Without one the parity test skips and the
// committed golden (tests/fixtures/lens-registry-golden.json, written from the
// example's output with QCR_UPDATE_GOLDEN=1) stands in, so the contract is
// checked on every machine.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { buildBenchAgents } from "../src/bench/runner.js";
import { loadConfig, type Config } from "../src/config.js";
import {
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
  identityVars,
  type BuiltAgent,
} from "@quickchatai/pi-quickreview/src/include.js";
import {
  loadAgentRegistry,
  loadBuiltAgents,
  parseAgentFile,
  type AgentRegistry,
} from "@quickchatai/pi-quickreview/src/engine/lens/registry.js";
import { buildScanAgents } from "../src/setup/scanbuild.js";
import { lensTuningAddenda, roundAgentModels } from "@quickchatai/pi-quickreview/src/lenstuning.js";
import { postingPolicyAddenda } from "@quickchatai/pi-quickreview/src/postingpolicy.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GOLDEN = join(ROOT, "tests", "fixtures", "lens-registry-golden.json");
const tmp = mkdtempSync(join(tmpdir(), "lens-registry-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const cfg: Config = loadConfig(join(ROOT, "tests", "fixtures", "config.toml"));

/** The VM's build, as wire.ts composes it (memory tools on, user-scope dir). */
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

const dirs = {
  vm: join(tmp, "vm"),
  bench: join(tmp, "bench"),
  scan: join(tmp, "scan"),
};
const emitted: Record<keyof typeof dirs, string[]> = { vm: [], bench: [], scan: [] };
const emittedBuilds = { vm: buildVm(dirs.vm) };
emitted.vm = emittedBuilds.vm.map((b) => b.name);
const benchCount = buildBenchAgents(ROOT, cfg, dirs.bench);
emitted.bench = readdirSync(dirs.bench).map((f) => f.replace(/\.md$/, ""));
emitted.scan = buildScanAgents(ROOT, dirs.scan, cfg).map((b) => b.name);

interface Row {
  name: string;
  model: string | undefined;
  tools: string[] | undefined;
}
const rows = (reg: AgentRegistry): Row[] =>
  [...reg.agents.values()]
    .map((a) => ({ name: a.name, model: a.model, tools: a.tools }))
    .sort((a, b) => a.name.localeCompare(b.name));

// ---- the example, when it is installed -----------------------------------

function findPiPackage(): string | null {
  const env = (process.env["QCR_PI_PACKAGE_DIR"] ?? "").trim();
  const candidates = [env];
  try {
    candidates.push(
      dirname(
        createRequire(import.meta.url).resolve("@earendil-works/pi-coding-agent/package.json"),
      ),
    );
  } catch {
    // not installed beside the repo
  }
  return (
    candidates.find(
      (c) => c !== "" && existsSync(join(c, "examples", "extensions", "subagent", "agents.ts")),
    ) ?? null
  );
}
const piPackage = findPiPackage();

interface ExampleAgent {
  name: string;
  description: string;
  tools?: string[];
  model?: string;
  systemPrompt: string;
  filePath: string;
}
async function exampleAgents(agentsHome: string): Promise<ExampleAgent[]> {
  // The example reads <PI_CODING_AGENT_DIR>/agents with scope "user".
  const home = join(tmp, `pihome-${createHash("sha1").update(agentsHome).digest("hex")}`);
  mkdirSync(home, { recursive: true });
  rmSync(join(home, "agents"), { recursive: true, force: true });
  writeFileSync(join(home, ".src"), agentsHome);
  symlinkSync(agentsHome, join(home, "agents"));
  const prev = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = home;
  try {
    const mod = (await import(
      pathToFileURL(join(piPackage!, "examples", "extensions", "subagent", "agents.ts")).href
    )) as {
      discoverAgents(cwd: string, scope: "user"): { agents: ExampleAgent[] };
    };
    return mod.discoverAgents(tmp, "user").agents;
  } finally {
    if (prev === undefined) delete process.env["PI_CODING_AGENT_DIR"];
    else process.env["PI_CODING_AGENT_DIR"] = prev;
  }
}

describe("the registry on every agent buildAgents emits", () => {
  it("buildBenchAgents reports the count it emitted", () => {
    expect(emitted.bench).toHaveLength(benchCount);
  });

  it.each(["vm", "bench", "scan"] as const)("%s: one entry per emitted agent", (which) => {
    const reg = loadBuiltAgents(dirs[which]);
    expect(reg.skipped).toEqual([]);
    expect(reg.names()).toEqual([...emitted[which]].sort());
    expect(reg.names().length).toBeGreaterThan(30);
    for (const a of reg.agents.values()) {
      expect(a.origin).toBe("built");
      expect(a.overrides).toBeNull();
      expect(a.body.length).toBeGreaterThan(100);
      expect(a.model, a.name).toMatch(/^.+\/.+/);
      expect(a.tools, a.name).toBeDefined();
    }
    expect(reg.customised()).toEqual([]);
  });

  it("carries the model spec whole, and splits the thinking level off it", () => {
    const reg = loadBuiltAgents(dirs.vm);
    const models = roundAgentModels(cfg);
    for (const built of emittedBuilds.vm) {
      const a = reg.get(built.name)!;
      expect(a.model, built.name).toBe(models[built.name] ?? cfg.models.tiers[built.tier]);
      expect(a.modelId, built.name).toBe(built.model);
      expect(a.thinking, built.name).toBe(built.thinking);
    }
  });

  // No lens leaf loads the memory extension (LENS_LEAVES_LOAD_MEMORY), so no
  // build names a memory tool; and none names `glob`, which pi has no tool for.
  it("no build holds a memory tool or a `glob`; the scan build is read-only", () => {
    const vm = loadBuiltAgents(dirs.vm);
    const bench = loadBuiltAgents(dirs.bench);
    const scan = loadBuiltAgents(dirs.scan);
    const sec = (r: AgentRegistry) =>
      [...r.agents.values()].find((a) => a.name.startsWith("pass-security--"))!.tools!;
    expect(sec(vm)).toEqual(["read", "bash", "grep"]);
    expect(sec(bench)).toEqual(["read", "bash", "grep"]);
    expect(sec(scan)).toEqual(["read", "grep", "find", "ls"]);
    for (const r of [vm, bench, scan])
      for (const a of r.agents.values())
        expect(
          a.tools!.filter((t) => t.startsWith("viking_") || t === "glob"),
          a.name,
        ).toEqual([]);
  });

  it("matches the committed golden of the example parser's name / model / tools", () => {
    const actual = {
      vm: rows(loadBuiltAgents(dirs.vm)),
      bench: rows(loadBuiltAgents(dirs.bench)),
      scan: rows(loadBuiltAgents(dirs.scan)),
    };
    if (process.env["QCR_UPDATE_GOLDEN"] === "1") {
      if (piPackage === null)
        throw new Error("QCR_UPDATE_GOLDEN needs a pi install (QCR_PI_PACKAGE_DIR)");
      return exampleAgents(dirs.vm).then(async (ex) => {
        const golden = {
          vm: ex,
          bench: await exampleAgents(dirs.bench),
          scan: await exampleAgents(dirs.scan),
        };
        const slim = Object.fromEntries(
          Object.entries(golden).map(([k, v]) => [
            k,
            v
              .map((a) => ({ name: a.name, model: a.model, tools: a.tools }))
              .sort((a, b) => a.name.localeCompare(b.name)),
          ]),
        );
        writeFileSync(GOLDEN, JSON.stringify(slim, null, 2) + "\n");
      });
    }
    const golden = JSON.parse(readFileSync(GOLDEN, "utf8")) as Record<string, Row[]>;
    expect(JSON.parse(JSON.stringify(actual))).toEqual(golden);
    return undefined;
  });
});

describe.skipIf(piPackage === null)("against pi's example parser (imported here only)", () => {
  it.each(["vm", "bench", "scan"] as const)(
    "%s: the same agents with the same name, model, tools, description and body",
    async (which) => {
      const ours = loadBuiltAgents(dirs[which]);
      const theirs = await exampleAgents(dirs[which]);
      expect(theirs.length).toBe(ours.agents.size);
      for (const ex of theirs) {
        const a = ours.get(ex.name);
        expect(a, ex.name).toBeDefined();
        expect(a!.model, ex.name).toBe(ex.model);
        expect(a!.tools, ex.name).toEqual(ex.tools);
        expect(a!.description, ex.name).toBe(ex.description);
        expect(a!.body, ex.name).toBe(ex.systemPrompt);
      }
    },
  );
});

describe("parseAgentFile and layers", () => {
  const file = (fm: string, body = "Body.\n") => `---\n${fm}---\n${body}`;

  it("reads both tools spellings, quoted scalars and a thinking field", () => {
    const a = parseAgentFile(
      file(`name: "x--y"\ndescription: 'd'\ntools: [read, "bash"]\nmodel: p/m\nthinking: high\n`),
      "/f.md",
      "built",
    );
    expect(a).toMatchObject({
      name: "x--y",
      description: "d",
      tools: ["read", "bash"],
      model: "p/m",
      modelId: "p/m",
      thinking: "high",
      body: "Body.",
    });
  });

  it("no tools line is no allowlist; the model suffix wins over the thinking field", () => {
    const a = parseAgentFile(
      file(`name: n\ndescription: d\nmodel: p/m:low\nthinking: high\ntools:\n`),
      "/f.md",
      "built",
    );
    expect(a).toMatchObject({
      tools: undefined,
      model: "p/m:low",
      modelId: "p/m",
      thinking: "low",
    });
  });

  it("refuses what the example skips: no frontmatter, no name, no description", () => {
    expect(parseAgentFile("just text", "/f.md", "built")).toMatch(/no frontmatter/);
    expect(parseAgentFile(file("description: d\n"), "/f.md", "built")).toMatch(/no name/);
    expect(parseAgentFile(file("name: n\n"), "/f.md", "built")).toMatch(/no description/);
  });

  it("a profile layer replaces a built agent and the registry says so", () => {
    const built = join(tmp, "layer-built");
    const prof = join(tmp, "layer-profile");
    mkdirSync(built, { recursive: true });
    mkdirSync(prof, { recursive: true });
    writeFileSync(
      join(built, "a.md"),
      file("name: a--x\ndescription: d\nmodel: p/m\n", "seed body\n"),
    );
    writeFileSync(join(built, "b.md"), file("name: b--x\ndescription: d\n"));
    writeFileSync(join(prof, "a.md"), file("name: a--x\ndescription: d\nmodel: p/m\n", "mine\n"));
    writeFileSync(join(prof, "bad.md"), "no frontmatter");
    const reg = loadAgentRegistry([
      { dir: built, origin: "built" },
      { dir: prof, origin: "profile" },
      { dir: join(tmp, "missing"), origin: "profile" },
    ]);
    expect(reg.names()).toEqual(["a--x", "b--x"]);
    expect(reg.get("a--x")).toMatchObject({
      body: "mine",
      origin: "profile",
      overrides: join(built, "a.md"),
    });
    expect(reg.get("b--x")).toMatchObject({ origin: "built", overrides: null });
    expect(reg.customised().map((a) => a.name)).toEqual(["a--x"]);
    expect(reg.skipped).toEqual([
      { filePath: join(prof, "bad.md"), reason: "no frontmatter block" },
    ]);
  });

  it("two files in one layer naming one agent: the first by filename wins, the other is reported", () => {
    const d = join(tmp, "dup");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "1.md"), file("name: n\ndescription: d\n", "one\n"));
    writeFileSync(join(d, "2.md"), file("name: n\ndescription: d\n", "two\n"));
    const reg = loadBuiltAgents(d);
    expect(reg.get("n")!.body).toBe("one");
    expect(reg.skipped).toHaveLength(1);
    expect(reg.skipped[0]!.reason).toMatch(/duplicate agent name n/);
  });

  it("registry reads nothing from the environment", () => {
    const src = readFileSync(
      join(ROOT, "packages", "pi-plugin", "src", "engine", "lens", "registry.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/process\.env|getAgentDir/);
  });
});
