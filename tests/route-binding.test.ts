// [P8.14] The bot's route binding: every bot round renders the templates of the
// host that runs it, and a debug round is delivered the same text.
//
// The bot has one host at a time (no mixed fleet). A worker's session has the
// engine's `lens` and `lens_wave` and no `subagent` (rule 9, D3); the tmux host's
// has the old pair. Dispatch writes the host's names into the order it builds
// (`SessionHooks.lensRuntime`), so the prompt, the task files and the saved payload of one
// round name one pair of tools, whatever `[pi] lens_runtime` says; the production
// renderer refuses an order written for the other host.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { parseConfig, sandboxRoot, type Config } from "../src/config.js";
import { dispatchOnce, type DispatchAdapter } from "../src/dispatch.js";
import { debugRoundOrder } from "../src/debugroundpi.js";
import type { DebugRoundSpec } from "../src/debuground.js";
import { ecosystemFor } from "../src/ecosystem.js";
import type { GateResult } from "../src/gate.js";
import type { PrFileEntry } from "../src/github.js";
import { identityVars } from "../src/include.js";
import { assertOrderFitsHost } from "../src/launchvocab.js";
import { sessionCommandMarker } from "../src/session-command.js";
import { PiSessionManager } from "../src/sessions.js";
import { StateStore } from "../src/state.js";
import { renderRoundPrompt, templateFileForOrder } from "../src/templates.js";
import type { RoundOrder, SessionHooks } from "../src/types.js";
import { openWorkerRig, type WorkerHostRig } from "./helpers/session-hooks-host.js";

const ROOT = resolve(process.cwd());
/** A PR number no other test uses: dispatch writes its task files under the sandbox's state/. */
const PR = 987_661;
const OLD_NAMES = /\bsubagent\b|\blaunch_plan\b/;
const NEW_NAMES = /\blens_wave\b|`lens` (tool|call)|\blens to call\b/;

class Adapter implements DispatchAdapter {
  async listPrFiles(): Promise<PrFileEntry[]> {
    return [
      { filename: "backend/api/views.py", additions: 40, deletions: 3, status: "modified" },
      { filename: "docs/guide.md", additions: 12, deletions: 0, status: "modified" },
    ];
  }
  async getPr(): Promise<{ base_ref: string; body?: string }> {
    return { base_ref: "master", body: "Adds tenant scoping to the views API." };
  }
  async addLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async removeLabel(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async deleteTeamReviewRequest(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
  async createReview(): Promise<GateResult> {
    return { executed: false, dryRunFile: "x" };
  }
}

function cleanup(): void {
  const state = join(sandboxRoot(), "state");
  for (const e of readdirSync(state, { withFileTypes: true }))
    if (e.name.startsWith(`pr-${PR}-`))
      rmSync(join(state, e.name), { recursive: true, force: true });
}
afterAll(cleanup);

function cfgOf(lensRuntime: "native" | "engine"): Config {
  const cfg = parseConfig(readFileSync(join(ROOT, "tests/fixtures/config.toml"), "utf8"));
  cfg.review.task_files = true;
  cfg.pi.lens_runtime = lensRuntime;
  return cfg;
}

interface Dispatched {
  order: RoundOrder;
  prompt: string;
  tasks: string[];
}

/** One real dispatch against `host`, rendered the way wire.ts renders for it. */
async function dispatchFor(
  host: Pick<SessionHooks, "lensRuntime">,
  configured: "native" | "engine",
): Promise<Dispatched> {
  cleanup();
  const cfg = cfgOf(configured);
  const store = new StateStore(":memory:");
  try {
    store.upsertPr({
      number: PR,
      state: "queued",
      head_sha: "head-1",
      title: "Scope the views API by tenant",
      author: "alice",
      trigger_ts: "2026-10-19T09:00:00Z",
      trigger_provenance: null,
      stale_recheck: 0,
      migration_gate: 0,
    });
    const prompts: string[] = [];
    const hooks: SessionHooks = {
      ...(host.lensRuntime ? { lensRuntime: host.lensRuntime } : {}),
      async dispatchRound(_o, prompt) {
        prompts.push(prompt);
      },
      async inject() {},
      async archiveAndClose() {},
    };
    const eco = ecosystemFor("django");
    const identity = identityVars(cfg);
    const orders = await dispatchOnce({
      cfg,
      store,
      adapter: new Adapter(),
      hooks,
      ecosystem: eco,
      // wire.ts's renderer, over the same binding.
      renderPrompt: (o, memory) => {
        assertOrderFitsHost(host, o);
        return renderRoundPrompt(
          readFileSync(join(ROOT, "prompts", templateFileForOrder(o)), "utf8"),
          o,
          memory,
          cfg.owner.name,
          eco,
          identity,
        );
      },
      now: () => new Date("2026-10-19T10:00:00Z"),
    });
    expect(orders).toHaveLength(1);
    const order = orders[0]!;
    return {
      order,
      prompt: prompts[0]!,
      tasks: (order.pass_task_files ?? []).map((t) => readFileSync(t.path, "utf8")),
    };
  } finally {
    store.close();
  }
}

const WORKER: Pick<SessionHooks, "lensRuntime"> = { lensRuntime: "engine" };
const TMUX: Pick<SessionHooks, "lensRuntime"> = {};

describe("[P8.14] which host an order is written for", () => {
  let rig: WorkerHostRig | undefined;
  afterEach(() => rig?.dispose());

  it("the worker host declares the engine tools, the tmux host declares none", () => {
    rig = openWorkerRig();
    expect(rig.host.lensRuntime).toBe("engine");
    expect("lensRuntime" in PiSessionManager.prototype).toBe(false);
  });

  it("the renderer refuses an order written for the other host", () => {
    const engine = { lens_runtime: "engine" } as const;
    expect(() => assertOrderFitsHost(WORKER, engine)).not.toThrow();
    expect(() => assertOrderFitsHost(WORKER, {})).toThrow(/worker host renders engine/);
    expect(() => assertOrderFitsHost(TMUX, {})).not.toThrow();
    expect(() => assertOrderFitsHost(TMUX, engine)).toThrow(/tmux host renders native/);
  });
});

describe("[P8.14] a bot round on the worker host renders engine templates", () => {
  it("the order, the prompt and every task file name lens and lens_wave, and never the old pair", async () => {
    const r = await dispatchFor(WORKER, "native");
    expect(r.order.lens_runtime).toBe("engine");
    expect(r.prompt).toMatch(NEW_NAMES);
    expect(r.prompt).not.toMatch(OLD_NAMES);
    expect(r.tasks.length).toBeGreaterThan(0);
    for (const task of r.tasks) expect(task).not.toMatch(OLD_NAMES);
  });

  it("the bot's host decides, not [pi] lens_runtime: the same round on engine config is the same prompt", async () => {
    const native = await dispatchFor(WORKER, "native");
    const engine = await dispatchFor(WORKER, "engine");
    expect(engine.prompt).toBe(native.prompt);
  });

  it("the tmux host still renders the native pair, whatever the config says", async () => {
    const r = await dispatchFor(TMUX, "engine");
    expect("lens_runtime" in r.order).toBe(false);
    expect(r.prompt).toMatch(OLD_NAMES);
    expect(r.prompt).not.toMatch(NEW_NAMES);
  });
});

describe("[P8.14] a debug round is delivered the same engine templates", () => {
  const dir = mkdtempSync(join(tmpdir(), "route-binding-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the saved payload of a worker-host round, with the lens section, names one pair of tools", async () => {
    const r = await dispatchFor(WORKER, "native");
    const payload = join(dir, "payload.md");
    writeFileSync(payload, r.prompt);
    const sha = createHash("sha256").update(readFileSync(payload)).digest("hex");
    const passes = join(dir, "passes");
    mkdirSync(passes, { recursive: true });
    const spec = {
      pr: PR,
      root: dir,
      payload_path: payload,
      payload_sha256: sha,
      passes_dir: passes,
      planned_wave: false,
      marker: sessionCommandMarker("cmd-1", sha),
    } as DebugRoundSpec;
    const order = debugRoundOrder(spec);
    const section = order.indexOf("## ENGINE LENS ROUTE");
    expect(section).toBeGreaterThan(0);
    // Everything before the section is the dispatched order: the engine's names only.
    expect(order.slice(0, section)).toMatch(NEW_NAMES);
    expect(order.slice(0, section)).not.toMatch(OLD_NAMES);
    expect(order.trimEnd().endsWith(spec.marker)).toBe(true);
  });
});
