// register-lens-agents — the built state/agents lens passes must reach
// pi-subagents via its globalThis registerAgent hook (live finding 2026-08-18:
// the extension's own agents dir is hardcoded; a config file cannot repoint
// it, so an unregistered pass degrades to a generic worker "acting as" it).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  builtAgentsDir,
  loadBuiltAgents,
  parseAgentFile,
  registerAll,
  type LensAgentConfig,
} from "../extensions/register-lens-agents.js";

const AGENT_MD = `---
name: pass-baseline--sol-med
description: general correctness lens
tools: read, bash, grep
model: openai-codex/gpt-5.6-sol
thinking: medium
---
You are the baseline lens.
`;

let dir: string | undefined;
function tempAgentsDir(files: Record<string, string>): string {
  dir = mkdtempSync(join(tmpdir(), "qcr-lens-agents-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("parseAgentFile", () => {
  it("splits frontmatter and body the way pi-subagents does", () => {
    const { frontmatter, body } = parseAgentFile(AGENT_MD);
    expect(frontmatter.name).toBe("pass-baseline--sol-med");
    expect(frontmatter.model).toBe("openai-codex/gpt-5.6-sol");
    expect(body).toBe("You are the baseline lens.\n");
  });

  it("treats a file without frontmatter as all body, no name", () => {
    const { frontmatter, body } = parseAgentFile("just text");
    expect(frontmatter).toEqual({});
    expect(body).toBe("just text");
  });
});

describe("loadBuiltAgents", () => {
  it("loads every .md with a name, mapping frontmatter to AgentConfig fields", () => {
    const d = tempAgentsDir({
      "pass-baseline--sol-med.md": AGENT_MD,
      "nameless.md": "no frontmatter here",
      "notes.txt": "ignored",
    });
    const agents = loadBuiltAgents(d);
    expect(agents).toHaveLength(1);
    const a = agents[0];
    expect(a.name).toBe("pass-baseline--sol-med");
    expect(a.tools).toEqual(["read", "bash", "grep"]);
    expect(a.thinking).toBe("medium");
    expect(a.systemPrompt).toContain("baseline lens");
    expect(a.filePath).toBe(join(d, "pass-baseline--sol-med.md"));
  });

  it("returns empty for a missing dir instead of throwing", () => {
    expect(loadBuiltAgents("/nonexistent/qcr-agents")).toEqual([]);
  });
});

describe("builtAgentsDir", () => {
  it("prefers QCR_BUILT_AGENTS_DIR, else <cwd>/state/agents", () => {
    expect(builtAgentsDir({ QCR_BUILT_AGENTS_DIR: "/x/agents" } as NodeJS.ProcessEnv, "/cwd")).toBe("/x/agents");
    expect(builtAgentsDir({} as NodeJS.ProcessEnv, "/cwd")).toBe(join("/cwd", "state", "agents"));
  });
});

describe("registerAll", () => {
  it("registers each built agent once and survives duplicate-name throws", () => {
    const d = tempAgentsDir({
      "pass-baseline--sol-med.md": AGENT_MD,
      "pass-validate--sol-high.md": AGENT_MD.replace(/pass-baseline--sol-med/, "pass-validate--sol-high"),
    });
    const seen: string[] = [];
    const hook = {
      registerAgent(c: LensAgentConfig) {
        // mirror the real hook: throw on duplicates
        if (seen.includes(c.name)) throw new Error(`Agent already registered: ${c.name}`);
        seen.push(c.name);
      },
      unregisterAgent() {},
    };
    const logs: string[] = [];
    expect(registerAll(hook, d, (m) => logs.push(m))).toBe(2);
    expect(seen.sort()).toEqual(["pass-baseline--sol-med", "pass-validate--sol-high"]);
    // second activation (reload) must not throw and registers nothing new
    expect(registerAll(hook, d, (m) => logs.push(m))).toBe(0);
    expect(logs[0]).toContain("registered 2");
  });
});

describe("makeToolCallRegistrar", () => {
  // The live failure mode this guards: pi-subagents' activate() reassigns its
  // agents array AFTER an early registration, wiping it. Registration must
  // therefore happen lazily at tool_call time and survive a later wipe.
  it("registers on the first tool call once the hook exists", async () => {
    const { makeToolCallRegistrar } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const seen: string[] = [];
    const attempt = makeToolCallRegistrar(
      () => ({ registerAgent: (c: LensAgentConfig) => {
        if (seen.includes(c.name)) throw new Error("dup");
        seen.push(c.name);
      }, unregisterAgent() {} }),
      d,
      () => {},
    );
    attempt();
    expect(seen).toEqual(["pass-baseline--sol-med"]);
    attempt(); // every later call is a cheap all-duplicates no-op
    expect(seen).toEqual(["pass-baseline--sol-med"]);
  });

  it("re-registers after the shared array is wiped (the live activate() reassignment)", async () => {
    const { makeToolCallRegistrar } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    let registry: string[] = [];
    const logs: string[] = [];
    const attempt = makeToolCallRegistrar(
      () => ({ registerAgent: (c: LensAgentConfig) => {
        if (registry.includes(c.name)) throw new Error("dup");
        registry.push(c.name);
      }, unregisterAgent() {} }),
      d,
      (m) => logs.push(m),
    );
    attempt();
    expect(registry).toEqual(["pass-baseline--sol-med"]);
    registry = []; // pi-subagents' activate(): agents = loadAgents()
    attempt();
    expect(registry).toEqual(["pass-baseline--sol-med"]);
    expect(logs.some((l) => l.includes("re-registered"))).toBe(true);
  });

  it("tolerates a hook that appears only on a later call, and warns FATAL once meanwhile", async () => {
    const { makeToolCallRegistrar } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const seen: string[] = [];
    const logs: string[] = [];
    let hook: { registerAgent(c: LensAgentConfig): void; unregisterAgent(): void } | undefined;
    const attempt = makeToolCallRegistrar(() => hook, d, (m) => logs.push(m));
    attempt();
    attempt();
    expect(logs.filter((l) => l.includes("FATAL"))).toHaveLength(1);
    hook = { registerAgent: (c) => seen.push(c.name), unregisterAgent() {} };
    attempt();
    expect(seen).toEqual(["pass-baseline--sol-med"]);
  });
});

// the stock researcher/scout/worker pin anthropic models + web
// extensions that cannot run in this container; they are swept out of the
// shared registry at tool_call time, every call (activate()'s array
// reassignment reloads them, so a one-shot removal would not stick).
describe("stock-agent unregistration", () => {
  it("names exactly the three dead stock agents", async () => {
    const { STOCK_AGENT_NAMES } = await import("../extensions/register-lens-agents.js");
    expect([...STOCK_AGENT_NAMES]).toEqual(["researcher", "scout", "worker"]);
  });

  it("unregisters researcher/scout/worker on every tool-call sweep, logging once", async () => {
    const { makeToolCallRegistrar } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const unregistered: string[] = [];
    const logs: string[] = [];
    const attempt = makeToolCallRegistrar(
      () => ({
        registerAgent: () => {},
        unregisterAgent: (name: string) => unregistered.push(name),
      }),
      d,
      (m) => logs.push(m),
    );
    attempt();
    expect(unregistered).toEqual(["researcher", "scout", "worker"]);
    attempt(); // the wipe-healing cadence: swept again on the next call
    expect(unregistered).toEqual(["researcher", "scout", "worker", "researcher", "scout", "worker"]);
    expect(logs.filter((l) => l.includes("unregistered stock agents"))).toHaveLength(1);
    expect(logs.some((l) => l.includes("DEGRADED"))).toBe(false);
  });

  it("survives an unregisterAgent that throws on an absent name (VERIFY-ON-PIN)", async () => {
    const { makeToolCallRegistrar } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const seen: string[] = [];
    const attempt = makeToolCallRegistrar(
      () => ({
        registerAgent: (c: LensAgentConfig) => {
          if (seen.includes(c.name)) throw new Error("dup");
          seen.push(c.name);
        },
        unregisterAgent: () => {
          throw new Error("Unknown agent");
        },
      }),
      d,
      () => {},
    );
    expect(() => attempt()).not.toThrow();
    expect(seen).toEqual(["pass-baseline--sol-med"]); // registration unharmed
  });

  it("degrades loudly (once) when the hook lacks unregisterAgent, still registering passes", async () => {
    const { makeToolCallRegistrar } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const seen: string[] = [];
    const logs: string[] = [];
    // A pin without the API: a hook exposing registerAgent only.
    const attempt = makeToolCallRegistrar(
      () => ({
        registerAgent: (c: LensAgentConfig) => {
          if (seen.includes(c.name)) throw new Error("dup");
          seen.push(c.name);
        },
      }),
      d,
      (m) => logs.push(m),
    );
    attempt();
    attempt();
    expect(seen).toEqual(["pass-baseline--sol-med"]);
    const degraded = logs.filter((l) => l.includes("DEGRADED"));
    expect(degraded).toHaveLength(1);
    // The degraded path names the fallback: the round templates' by-name ban.
    expect(degraded[0]).toContain("researcher, scout, worker");
    expect(degraded[0]).toContain("round templates forbid them by name");
  });
});

describe("session wiring", () => {
  it("extensionPaths ships register-lens-agents after the base extensions", async () => {
    const { PiSessionManager } = await import("../src/sessions.js");
    const { loadConfig } = await import("../src/config.js");
    const cfg = loadConfig(join(process.cwd(), "config.toml"));
    const mgr = new PiSessionManager({ cfg, root: "/s", exec: (async () => ({ stdout: "", stderr: "", code: 0 })) as never });
    expect(mgr.extensionPaths()).toContain("/s/extensions/register-lens-agents.ts");
  });
});
