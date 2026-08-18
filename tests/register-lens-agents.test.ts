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

describe("registerWhenReady", () => {
  it("registers immediately when the hook already exists", async () => {
    const { registerWhenReady } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const seen: string[] = [];
    registerWhenReady(
      () => ({ registerAgent: (c: LensAgentConfig) => seen.push(c.name), unregisterAgent() {} }),
      d,
      () => {},
    );
    expect(seen).toEqual(["pass-baseline--sol-med"]);
  });

  it("polls until the hook appears (argv extensions load before globals)", async () => {
    const { registerWhenReady } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const seen: string[] = [];
    let hook: { registerAgent(c: LensAgentConfig): void; unregisterAgent(): void } | undefined;
    const timers: Array<() => void> = [];
    registerWhenReady(() => hook, d, () => {}, {
      intervalMs: 1,
      timeoutMs: 10,
      setInterval: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    expect(seen).toEqual([]); // not yet — hook absent at activate
    timers[0]!(); // tick 1: still absent
    hook = { registerAgent: (c) => seen.push(c.name), unregisterAgent() {} };
    timers[0]!(); // tick 2: hook appeared
    expect(seen).toEqual(["pass-baseline--sol-med"]);
  });

  it("logs FATAL once the timeout elapses without a hook", async () => {
    const { registerWhenReady } = await import("../extensions/register-lens-agents.js");
    const d = tempAgentsDir({ "pass-baseline--sol-med.md": AGENT_MD });
    const logs: string[] = [];
    const timers: Array<() => void> = [];
    registerWhenReady(() => undefined, d, (m) => logs.push(m), {
      intervalMs: 5,
      timeoutMs: 10,
      setInterval: ((fn: () => void) => {
        timers.push(fn);
        return 0 as unknown as ReturnType<typeof setInterval>;
      }) as typeof setInterval,
      clearInterval: (() => {}) as typeof clearInterval,
    });
    timers[0]!();
    timers[0]!(); // waited 10ms >= timeout
    expect(logs.some((l) => l.includes("FATAL"))).toBe(true);
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
