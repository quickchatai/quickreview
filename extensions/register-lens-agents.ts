// register-lens-agents — makes the daemon-built lens pass agents visible to
// the pi-subagents extension.
//
// WHY THIS EXISTS (live finding, 2026-08-18 first phase-3 deploy): the pinned
// pi-subagents extension (amosblomqvist/pi-subagents @ 1f54189) discovers
// agent .md files ONLY from `<its own dir>/agents` — a root-owned image layer
// holding its stock researcher/scout/worker — and reads config ONLY from
// `<its own dir>/config.json`. The `.pi/subagents.config.json` this repo used
// to ship (`agentsDir` key) was an unverified VERIFY-ON-PIN assumption and is
// INERT: sessions saw "Unknown agent: pass-…" and improvised a generic worker
// "acting as" the lens, dropping the lens prompt, tier and execution policy.
//
// THE SANCTIONED SEAM (verified in the pinned commit, index.ts ~line 156):
// pi-subagents exposes `globalThis.__pi_subagents = { registerAgent,
// unregisterAgent }` explicitly so "other extensions loaded via jiti … can
// access the shared agents array". This extension walks the daemon's built
// agents dir (state/agents/<pass>--<tier>.md, written by buildAgents in
// src/include.ts) and registers each with that hook.
//
// Load order: pi-subagents rides the global ~/.pi/agent/settings.json (every
// pi process), while THIS extension rides the per-session `--extension` argv
// (sessions.ts extensionPaths). Globals load before argv extensions
// (// VERIFY-ON-PIN: observed order on 0.84.1 — settings extensions register
// first in the boot banner), so the hook exists by the time we run. That
// asymmetry is deliberate and load-bearing: pi-subagents' CHILD processes get
// only the settings.json extensions, so the pass agents are never registered
// inside a child — a pass cannot fan out into another pass, which structurally
// enforces the passes-are-leaves rule even if a frontmatter slipped through.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Pi } from "@earendil-works/pi-coding-agent";

/** Mirror of pi-subagents' AgentConfig (structural — we don't import from the
 * pinned repo; its fields are stable at the pinned commit). */
export interface LensAgentConfig {
  name: string;
  description: string;
  tools: string[];
  model: string;
  thinking: string;
  systemPrompt: string;
  filePath: string;
}

interface SubagentsHook {
  registerAgent(config: LensAgentConfig): void;
  unregisterAgent(name: string): void;
}

/** Same `---` frontmatter split pi-subagents' own loadAgents performs. */
export function parseAgentFile(content: string): { frontmatter: Record<string, string>; body: string } {
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(content);
  if (!m) return { frontmatter: {}, body: content };
  const frontmatter: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return { frontmatter, body: content.slice(m[0].length) };
}

/** Read every built agent definition in `dir` (non-recursive, .md only). */
export function loadBuiltAgents(dir: string): LensAgentConfig[] {
  const out: LensAgentConfig[] = [];
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const filePath = join(dir, entry);
    const { frontmatter, body } = parseAgentFile(readFileSync(filePath, "utf8"));
    if (!frontmatter.name) continue;
    out.push({
      name: frontmatter.name,
      description: frontmatter.description ?? "",
      tools: (frontmatter.tools ?? "").split(",").map((t) => t.trim()).filter(Boolean),
      // buildAgents always writes model+thinking; defaults only defend against
      // a hand-dropped file. NEVER default to an anthropic model here — the
      // container's auth is ChatGPT OAuth (openai-codex/ prefix).
      model: frontmatter.model ?? "openai-codex/gpt-5.6-sol",
      thinking: frontmatter.thinking ?? "medium",
      systemPrompt: body,
      filePath,
    });
  }
  return out;
}

/** The built-agents dir: per-session env override, else <cwd>/state/agents
 * (every session's cwd is the sandbox root). */
export function builtAgentsDir(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): string {
  return env.QCR_BUILT_AGENTS_DIR ? resolve(env.QCR_BUILT_AGENTS_DIR) : join(cwd, "state", "agents");
}

/** Register everything in `dir` with the hook. Duplicate names are skipped
 * (registerAgent throws on them — harmless if a reload re-runs activation). */
export function registerAll(hook: SubagentsHook, dir: string, log: (msg: string) => void): number {
  let n = 0;
  for (const agent of loadBuiltAgents(dir)) {
    try {
      hook.registerAgent(agent);
      n += 1;
    } catch {
      // already registered — fine
    }
  }
  log(`register-lens-agents: registered ${n} built pass agents from ${dir}`);
  return n;
}

export default function activate(_pi: Pi): void {
  const hook = (globalThis as { __pi_subagents?: SubagentsHook }).__pi_subagents;
  if (!hook) {
    // Loud, unmissable: without the hook every lens spawn degrades to a
    // generic worker. This means pi-subagents did not load before us —
    // check ~/.pi/agent/settings.json and the extension load order.
    console.error(
      "register-lens-agents: FATAL — globalThis.__pi_subagents missing; " +
        "pi-subagents not loaded (or loaded after this extension). " +
        "Lens passes will NOT resolve.",
    );
    return;
  }
  registerAll(hook, builtAgentsDir(), (msg) => console.error(msg));
}
