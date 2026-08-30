// subagents — first-party glue over pi's OWN subagent extension.
//
// The third-party amosblomqvist/pi-subagents extension is REMOVED (owner,
// 2026-08-30: unlicensed upstream, stale, and pi now ships a first-party
// equivalent inside the pinned npm package). This file is the ONE loader for
// that native extension, on both surfaces (VM sessions via
// `src/sessions.ts` extensionPaths, companion via `src/tui/companion.ts`
// piArgv), and it exists for three reasons the native code does not cover:
//
//  1. **Sourcing without drift.** The native extension is imported AT RUNTIME
//     from the installed pi package
//     (`<getExamplesPath()>/extensions/subagent/index.ts` — `examples/` ships
//     in the published tarball, verified against 0.84.4, package.json
//     `files`). There is no vendored copy, so there is nothing that can drift
//     from the rule-7 pin: bumping pi bumps the extension with it.
//
//  2. **The leaves invariant needs a process-wide cap and a scope pin.** The
//     native tool caps concurrency only WITHIN one `tasks:[…]` call
//     (MAX_CONCURRENCY = 4, index.ts) — multiple single-mode `subagent` calls
//     in one assistant turn (the fan-out pattern the round templates mandate)
//     run with NO cap at all, because pi dispatches a turn's tool calls via
//     Promise.all. The weighted semaphore below restores the process-wide cap
//     the old extension had (default 4; the VM passes 6 via
//     QCR_SUBAGENT_MAX_CONCURRENCY, from config.toml [pi]
//     subagent_max_concurrency).
//
//  3. **Child processes must never see repo-controlled pi config.** Native
//     children spawn as `pi --mode json -p --no-session` WITHOUT
//     `--no-extensions` (the old extension passed it), so a child's cwd
//     decides which PROJECT `.pi/` resources it loads — and
//     `defaultProjectTrust = "always"` (the no-stall decision) trusts them
//     all. A task `cwd` pointing into a reviewed-repo worktree would load
//     that repo's `.pi/extensions` into a reviewer child. The sanitizer
//     therefore STRIPS every `cwd` param (top-level, tasks[], chain[]): a
//     child always runs in the parent session's own cwd (the sandbox root /
//     /workspace — first-party ground), and passes address the worktree by
//     absolute path exactly as their task strings already do. It also pins
//     `agentScope` (default "user": agents come from ~/.pi/agent/agents,
//     which both entrypoints symlink to the sanctioned agent dir — built
//     state/agents on the VM, docker/companion/agents in the companion) and
//     forces `confirmProjectAgents: false` (never an interactive modal).
//
// What stays structural without any glue: children never gain the `subagent`
// tool (this extension rides per-spawn argv, never the global settings.json,
// and children load only global extensions), so a pass cannot fan out — the
// single-shepherd leaves rule (root CLAUDE.md rule 9). Children DO now load
// the globally-registered bash-guard, which is a strengthening: the old
// `--no-extensions` children had only the prompt-level exec policy.
//
// VERIFY-ON-PIN (0.84.4, read statically from the published tarball; live
// smoke listed in the report):
//  - native child argv is `--mode json -p --no-session` + optional
//    --model/--thinking/--tools/--append-system-prompt (examples/extensions/
//    subagent/index.ts, runSingleAgent) — `-p`/`--no-session`/`--mode json`
//    all read as a LEAF by the vendored OpenViking fork's qcr-leaf.ts;
//  - `--tools` names missing from the child's registry are IGNORED, never a
//    startup error (dist/core/agent-session.js _refreshToolRegistry);
//  - `--model provider/id:<thinking>` shorthand sets the thinking level
//    (dist/main.js "Allow --model <pattern>:<thinking>"), which is how the
//    built agents' per-tier thinking survives the native extension reading
//    only the `model:` frontmatter field;
//  - a jiti-loaded extension can dynamic-import the package root and a .ts
//    file inside the installed package. If either import fails the tool is
//    simply never registered and the round templates' "Unknown agent = STOP"
//    rule holds — logged FATAL below, never a crashed pi.
import type { Pi, PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

/** Env var pinning the discovery scope. "user" (default) reads ONLY
 * ~/.pi/agent/agents — repo-controlled `.pi/agents` dirs are unreachable no
 * matter what the model asks for. */
export const SCOPE_ENV = "QCR_SUBAGENT_SCOPE";

/** Env var carrying the process-wide child cap (VM: 6, from config.toml
 * [pi] subagent_max_concurrency riding the session command line). */
export const CONCURRENCY_ENV = "QCR_SUBAGENT_MAX_CONCURRENCY";

/** Default process-wide cap — the companion's desktop number; the old
 * extension's config.json default was the same 4. */
export const DEFAULT_MAX_CONCURRENCY = 4;

/** The native extension's own within-one-call concurrency constant
 * (examples/extensions/subagent/index.ts MAX_CONCURRENCY). A parallel call
 * never runs more than this many children at once regardless of our permits,
 * so it is also the honest weight ceiling for one call. */
export const NATIVE_IN_CALL_CONCURRENCY = 4;

const VALID_SCOPES = new Set(["user", "project", "both"]);

/** Resolve the pinned scope from the environment (invalid/absent → "user"). */
export function resolveScope(env: Record<string, string | undefined> = process.env): string {
  const raw = (env[SCOPE_ENV] ?? "").trim();
  return VALID_SCOPES.has(raw) ? raw : "user";
}

/** Resolve the process-wide cap from the environment (invalid/absent → 4).
 * Strict digits only — "1e3" or "6x" is a misconfiguration, and a
 * misconfiguration falls back to the safe default rather than whatever
 * parseInt salvages from the prefix. */
export function resolveMaxConcurrency(env: Record<string, string | undefined> = process.env): number {
  const raw = (env[CONCURRENCY_ENV] ?? "").trim();
  if (!/^\d{1,2}$/.test(raw)) return DEFAULT_MAX_CONCURRENCY;
  const n = Number.parseInt(raw, 10);
  return n >= 1 && n <= 64 ? n : DEFAULT_MAX_CONCURRENCY;
}

/** Drop `cwd` from a task/chain item, leaving the rest untouched. */
function stripCwd(item: unknown): unknown {
  if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
  const { cwd: _cwd, ...rest } = item as Record<string, unknown>;
  return rest;
}

/**
 * Pin scope + trust behaviour and strip every `cwd` before the native tool
 * sees the params. Reason 3 in the header: a child must never run inside a
 * reviewed-repo worktree, where always-on project trust would load that
 * repo's `.pi/` resources into a reviewer process.
 */
export function sanitizeParams(
  params: Record<string, unknown>,
  env: Record<string, string | undefined> = process.env,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...params, agentScope: resolveScope(env), confirmProjectAgents: false };
  delete out.cwd;
  if (Array.isArray(out.tasks)) out.tasks = out.tasks.map(stripCwd);
  if (Array.isArray(out.chain)) out.chain = out.chain.map(stripCwd);
  return out;
}

/**
 * Semaphore weight of one call: how many children it can have in flight at
 * once. Single and chain calls run one child at a time; a parallel call runs
 * up to min(tasks, native's own in-call cap). Clamped to `permits` so one
 * oversized call can always start (it self-limits inside).
 */
export function callWeight(params: Record<string, unknown>, permits: number): number {
  const tasks = Array.isArray(params.tasks) ? params.tasks.length : 0;
  if (tasks > 1) return Math.max(1, Math.min(tasks, NATIVE_IN_CALL_CONCURRENCY, permits));
  return 1;
}

/** A weighted counting semaphore (FIFO). */
export class WeightedSemaphore {
  private available: number;
  private readonly waiters: Array<{ weight: number; resolve: () => void }> = [];

  constructor(readonly permits: number) {
    this.available = permits;
  }

  /** Number of permits currently held (for tests/diagnostics). */
  get held(): number {
    return this.permits - this.available;
  }

  async acquire(weight: number): Promise<void> {
    const w = Math.max(1, Math.min(weight, this.permits));
    if (this.available >= w && this.waiters.length === 0) {
      this.available -= w;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push({ weight: w, resolve });
    });
  }

  release(weight: number): void {
    this.available += Math.max(1, Math.min(weight, this.permits));
    if (this.available > this.permits) this.available = this.permits;
    while (this.waiters.length > 0 && this.waiters[0] !== undefined && this.available >= this.waiters[0].weight) {
      const next = this.waiters.shift();
      if (!next) break;
      this.available -= next.weight;
      next.resolve();
    }
  }
}

type ToolExecute = PiToolDefinition["execute"];

/** Wrap the native tool's execute with the sanitizer + the semaphore. */
export function wrapExecute(
  execute: ToolExecute,
  semaphore: WeightedSemaphore,
  env: Record<string, string | undefined> = process.env,
): ToolExecute {
  return async function wrapped(this: unknown, id, params, signal, onUpdate, ctx) {
    const safe = sanitizeParams(params ?? {}, env);
    const weight = callWeight(safe, semaphore.permits);
    await semaphore.acquire(weight);
    try {
      return await execute.call(this, id, safe, signal, onUpdate, ctx);
    } finally {
      semaphore.release(weight);
    }
  };
}

/** The native extension's path inside the installed pi package. */
export function nativeExtensionPath(examplesPath: string): string {
  return join(examplesPath, "extensions", "subagent", "index.ts");
}

export default async function activate(pi: Pi): Promise<void> {
  const log = (msg: string) => console.error(msg);

  let factory: (api: unknown) => void | Promise<void>;
  let version = "unknown";
  try {
    // Resolved inside the pi process, so the import can only ever see the
    // installed (= pinned) package — the drift-free sourcing in the header.
    const pkg = (await import("@earendil-works/pi-coding-agent")) as unknown as {
      getExamplesPath(): string;
      VERSION?: string;
    };
    version = pkg.VERSION ?? "unknown";
    const mod = (await import(nativeExtensionPath(pkg.getExamplesPath()))) as {
      default?: (api: unknown) => void | Promise<void>;
    };
    if (typeof mod.default !== "function") throw new Error("native subagent extension has no default export");
    factory = mod.default;
  } catch (err) {
    // Loud, unmissable, never a crashed pi: without the tool every planned
    // lens spawn fails and the round templates order STOP + anomaly rather
    // than a stand-in (same degrade stance as the old register-lens-agents).
    log(
      `subagents: FATAL — could not load pi's native subagent extension (pi ${version}): ` +
        `${err instanceof Error ? err.message : String(err)}. The subagent tool will NOT exist in this session.`,
    );
    return;
  }

  const maxConcurrency = resolveMaxConcurrency();
  const scope = resolveScope();
  const semaphore = new WeightedSemaphore(maxConcurrency);

  // Hand the native factory a shim that intercepts registerTool and wraps the
  // subagent tool's execute; everything else passes through bound to the real
  // API (bind keeps pi's own `this` for its class methods).
  const shim = new Proxy(pi as object, {
    get(target, prop, receiver) {
      if (prop === "registerTool") {
        return (definition: PiToolDefinition) => {
          const real = (target as Pi).registerTool?.bind(target);
          if (!real) {
            log("subagents: DEGRADED — pi.registerTool unavailable; subagent tool not registered.");
            return;
          }
          if (definition?.name === "subagent" && typeof definition.execute === "function") {
            real({ ...definition, execute: wrapExecute(definition.execute.bind(definition), semaphore) });
            log(
              `subagents: native subagent tool registered (pi ${version}, scope=${scope}, ` +
                `max_concurrency=${maxConcurrency})`,
            );
          } else {
            real(definition);
          }
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });

  await factory(shim);
}
