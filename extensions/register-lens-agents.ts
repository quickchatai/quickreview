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
// Load order (VERIFIED live 2026-08-18 on 0.84.1): per-session `--extension`
// argv extensions load BEFORE the global ~/.pi/agent/settings.json ones, so
// at activate() the hook does not exist yet — registration therefore POLLS
// for it (registerWhenReady) rather than assuming order either way. The
// argv/global asymmetry is deliberate and load-bearing: pi-subagents' CHILD
// processes get only the settings.json extensions, so the pass agents are
// never registered inside a child — a pass cannot fan out into another pass,
// which structurally enforces the passes-are-leaves rule even if a
// frontmatter slipped through.
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
  if (!m || m[1] === undefined) return { frontmatter: {}, body: content };
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

/** Poll for the hook instead of assuming extension load order. VERIFIED live
 * 2026-08-18: per-session `--extension` argv extensions load BEFORE the global
 * settings.json ones, so at our activate() the hook does not exist yet —
 * an eager read logged FATAL on every session. The model's first turn is
 * seconds away at minimum, so a few-second grace window closes the race. */
export function registerWhenReady(
  getHook: () => SubagentsHook | undefined,
  dir: string,
  log: (msg: string) => void,
  opts: { intervalMs?: number; timeoutMs?: number; setInterval?: typeof globalThis.setInterval; clearInterval?: typeof globalThis.clearInterval } = {},
): void {
  const first = getHook();
  if (first) {
    registerAll(first, dir, log);
    return;
  }
  const intervalMs = opts.intervalMs ?? 250;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const setI = opts.setInterval ?? setInterval;
  const clearI = opts.clearInterval ?? clearInterval;
  let waited = 0;
  const timer = setI(() => {
    waited += intervalMs;
    const hook = getHook();
    if (hook) {
      clearI(timer);
      registerAll(hook, dir, log);
      return;
    }
    if (waited >= timeoutMs) {
      clearI(timer);
      // Loud, unmissable: without the hook every lens spawn degrades to a
      // generic worker acting as the lens.
      log(
        "register-lens-agents: FATAL — globalThis.__pi_subagents never appeared; " +
          "pi-subagents not loaded in this process. Lens passes will NOT resolve.",
      );
    }
  }, intervalMs);
  // Never hold the process open just for this timer.
  (timer as { unref?: () => void }).unref?.();
}

export default function activate(_pi: Pi): void {
  registerWhenReady(
    () => (globalThis as { __pi_subagents?: SubagentsHook }).__pi_subagents,
    builtAgentsDir(),
    (msg) => console.error(msg),
  );
}
