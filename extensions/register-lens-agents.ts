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
  // VERIFY-ON-PIN: unregisterAgent is exposed alongside registerAgent on the
  // globalThis hook at the pinned pi-subagents commit (index.ts ~line 156),
  // but it has never been exercised live and its absence must not break
  // registration — hence optional here, with a loud degraded path below.
  unregisterAgent?(name: string): void;
}

/** The stock agents pi-subagents loads from its hardcoded agents dir. They pin
 * anthropic models and web-search/web-fetch extensions that cannot run in this
 * container (auth is ChatGPT OAuth — `openai-codex/` only; no anthropic key,
 * no web extensions), so all three are permanently dead weight a session can
 * mistake for a usable fallback (first-night audit F7). They are
 * unregistered on EVERY tool_call sweep, not once: pi-subagents' activate()
 * reloads them whenever it reassigns the shared agents array — the same wipe
 * the register loop heals from. */
export const STOCK_AGENT_NAMES = ["researcher", "scout", "worker"] as const;

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

/** Why registration is re-attempted on EVERY tool_call, not done once at
 * activate (both VERIFIED live 2026-08-18, the hard way):
 *
 * 1. Argv extensions load before the global settings.json ones, so at our
 *    activate() the hook may not exist yet.
 * 2. Worse: pi-subagents' module load exposes the hook immediately, but its
 *    own activate() later runs `agents = loadAgents()` — REASSIGNING the
 *    array and silently discarding anything registered before that point. A
 *    one-shot early registration therefore "succeeds" and is then wiped
 *    (that is exactly what happened to the first fix: the throwaway session
 *    logged "registered 22" and the next real round still got
 *    "Unknown agent: pass-validate--sol-high").
 *
 * The only ordering guarantee we actually have: by the time the MODEL calls
 * any tool, every extension's activate() has long finished. So we register
 * lazily on the tool_call event (fires before the tool executes — the same
 * pre-execution hook bash-guard vetoes on), and re-attempt on every call:
 * registerAgent throws on duplicates, making re-attempts cheap no-ops, and a
 * fresh wipe (should one ever happen again) heals on the next call. The
 * configs are read from disk once and cached. */
export function makeToolCallRegistrar(
  getHook: () => SubagentsHook | undefined,
  dir: string,
  log: (msg: string) => void,
): () => void {
  let cached: LensAgentConfig[] | undefined;
  let everRegistered = false;
  let warnedNoHook = false;
  let everUnregisteredStock = false;
  let warnedNoUnregister = false;
  return () => {
    const hook = getHook();
    if (!hook) {
      if (!warnedNoHook) {
        warnedNoHook = true;
        // Loud, unmissable: without the hook every planned lens spawn fails
        // (the round templates order STOP + anomaly rather than a stand-in).
        log(
          "register-lens-agents: FATAL — globalThis.__pi_subagents missing at first tool call; " +
            "pi-subagents not loaded in this process. Lens passes will NOT resolve.",
        );
      }
      return;
    }
    cached ??= loadBuiltAgents(dir);
    let n = 0;
    for (const agent of cached) {
      try {
        hook.registerAgent(agent);
        n += 1;
      } catch {
        // already registered — fine
      }
    }
    if (n > 0 && !everRegistered) {
      everRegistered = true;
      log(`register-lens-agents: registered ${n} built pass agents from ${dir}`);
    } else if (n > 0) {
      // A later re-registration means something wiped the shared array again.
      log(`register-lens-agents: re-registered ${n} pass agents (registry was reset)`);
    }

    // sweep the dead stock agents out on every call, same cadence as
    // registration — activate()'s array reassignment reloads them, so a
    // one-shot removal would not stick.
    // VERIFY-ON-PIN: whether unregisterAgent throws on an already-absent name
    // is unverified at 0.84.1 — hence the per-name try/catch.
    if (typeof hook.unregisterAgent === "function") {
      for (const name of STOCK_AGENT_NAMES) {
        try {
          hook.unregisterAgent(name);
        } catch {
          // already gone — fine
        }
      }
      if (!everUnregisteredStock) {
        everUnregisteredStock = true;
        log(
          `register-lens-agents: unregistered stock agents (${STOCK_AGENT_NAMES.join(", ")}) — ` +
            "their model pins/extensions cannot run in this container",
        );
      }
    } else if (!warnedNoUnregister) {
      warnedNoUnregister = true;
      // DEGRADED, never silent: the round templates' by-name ban ("stock
      // researcher/scout/worker are off-limits") becomes the only defence.
      log(
        "register-lens-agents: DEGRADED — __pi_subagents.unregisterAgent unavailable at this pin; " +
          `stock agents (${STOCK_AGENT_NAMES.join(", ")}) stay advertised. ` +
          "The round templates forbid them by name; sessions must not call them.",
      );
    }
  };
}

export default function activate(pi: Pi): void {
  const attempt = makeToolCallRegistrar(
    () => (globalThis as { __pi_subagents?: SubagentsHook }).__pi_subagents,
    builtAgentsDir(),
    (msg) => console.error(msg),
  );
  pi.on("tool_call", () => {
    attempt();
  });
}
