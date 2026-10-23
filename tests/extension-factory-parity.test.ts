// P3.1: shim(env X) registers the same events, tools and resolved config as
// createX(config X). One case per extension that has a factory; P3.2-P3.4 add
// theirs here. The harness (tests/helpers/extension-parity.ts) runs both sides
// through pi's own extension loader.
import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extension, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import {
  bashGuardConfigFromEnv,
  createBashGuard,
  type BashGuardConfig,
} from "@quickchatai/pi-quickreview/extensions/bash-guard.js";
import { createFindingClusters } from "@quickchatai/pi-quickreview/extensions/finding-clusters.js";
import {
  createLedgerPin,
  ledgerPinConfigFromEnv,
} from "@quickchatai/pi-quickreview/extensions/ledger-pin.js";
import {
  createCompanionGuard,
  companionGuardConfigFromEnv,
} from "../extensions/companion-guard.js";
import { createInjectBridge } from "../extensions/inject-bridge.js";
import {
  interactiveHostFor,
  interactiveLens,
} from "@quickchatai/pi-quickreview/extensions/lens.js";
import { createMutedTheme } from "../extensions/muted-theme.js";
import { createOnboarding } from "../extensions/onboarding.js";
import { createSetup } from "../extensions/setup.js";
import { createTuiView, resolveFeedDir } from "../extensions/tui-view.js";
import { createOpenViking } from "../extensions/vendor/openviking-pi/index.js";
import {
  openVikingConfigFromProcess,
  type OpenVikingConfig,
} from "../extensions/vendor/openviking-pi/qcr-shim.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";
import { loadFactory, loadShim, withEnv, type ParityCase } from "./helpers/extension-parity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Calls a registered tool the way pi would, and answers its text. */
async function callTool(ext: Extension, name: string, params: Record<string, unknown>) {
  const def = ext.tools.get(name)!.definition;
  const res = await def.execute("probe", params as never, undefined, undefined, {} as never);
  return res.content.map((c) => (c.type === "text" ? c.text : ""));
}

/** The ledger-pin case: a session that writes its own ledger, then compacts. The
 * shim reads its identity from env, the factory from the config, and both must
 * mirror the same snapshot file and answer the compaction hook the same way. */
function ledgerPinCase(): ParityCase<never> {
  const dir = mkdtempSync(join(tmpdir(), "qcr-parity-ledger-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const snapshotPath = join(dir, "pr-42.md");
  const env = {
    QCR_SESSION_NAME: "pr-42",
    QCR_PR: "42",
    QCR_PR_META: "PR #42 parity",
    QCR_LEDGER_FILE: snapshotPath,
    QCR_SANDBOX_ROOT: undefined,
  };
  const config = { prMeta: "PR #42 parity", ownPr: 42, snapshotPath };
  const message = (text: string) => ({
    message: { role: "assistant", content: [{ type: "text", text }] },
    toolResults: [],
  });
  return {
    shimPath: join(ROOT, "extensions", "cli", "ledger-pin.ts"),
    env,
    config: config as never,
    factory: (c) => createLedgerPin(c as never),
    resolved: {
      fromEnv: (e) => ledgerPinConfigFromEnv(e, process.cwd()),
      fromConfig: (c) => c,
    },
    probe: async (ext) => {
      rmSync(snapshotPath, { force: true });
      const turnEnd = ext.handlers.get("turn_end")![0]!;
      await turnEnd(message("LEDGER PR #7 @ aaa\nsibling") as never, {} as never);
      const afterSibling = readExisting(snapshotPath);
      await turnEnd(message("chat\n\nLEDGER PR #42 @ abc\nF1 open") as never, {} as never);
      // No model in this ctx, so pi's default compaction runs: the hook answers nothing.
      const compact = ext.handlers.get("session_before_compact")![0]!;
      const verdict = await compact(
        { type: "session_before_compact", branchEntries: [message("x")] } as never,
        {} as never,
      );
      return { afterSibling, snapshot: readExisting(snapshotPath), verdict: verdict ?? null };
    },
  };
}

function readExisting(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** P3.3: bash-guard. The shim reads the sandbox root, replay and the secrets dirs
 * from env at activation; the factory takes them as config. What the guard
 * answers for the same calls (the /proc denies, a secrets dir named in the env,
 * a sanctioned script from and away from the root) must match. */
function bashGuardCase(): ParityCase<BashGuardConfig> {
  const dir = mkdtempSync(join(tmpdir(), "qcr-parity-guard-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const env = {
    QCR_SANDBOX_ROOT: dir,
    QCR_REPLAY: undefined,
    HOME: "/home/parity",
    XDG_CONFIG_HOME: undefined,
    QCR_INSTALL: "acme",
    QCR_IPC_SOCKET: undefined,
    QCR_CONFIG: undefined,
    QCR_CONFIG_HOME: undefined,
    QCR_SECRETS_MOUNT: "/mnt/parity-secrets",
    QC_SECRETS_DIR: undefined,
  };
  const setEnv = Object.fromEntries(
    Object.entries(env).filter((e): e is [string, string] => e[1] !== undefined),
  );
  return {
    shimPath: join(ROOT, "extensions", "cli", "bash-guard.ts"),
    env,
    config: bashGuardConfigFromEnv(setEnv, dir),
    factory: createBashGuard,
    resolved: {
      fromEnv: (e) => bashGuardConfigFromEnv(e, dir),
      fromConfig: (c) => c,
    },
    probe: async (ext) => {
      const guard = ext.handlers.get("tool_call")![0]!;
      const call = (toolName: string, input: Record<string, unknown>, cwd = dir) =>
        guard({ type: "tool_call", toolCallId: "t", toolName, input } as never, { cwd } as never);
      const verdicts: Record<string, unknown> = {};
      for (const command of [
        "git status",
        "cat /proc/self/environ",
        "head -c 9 /proc/1/mem",
        "cat /mnt/parity-secrets/app_id",
        "cat $HOME/.config/qcr/$QCR_INSTALL/secrets/app.pem",
        "scripts/pr-context.sh 1",
        "gh pr review 5 --approve",
      ])
        verdicts[command] = (await call("bash", { command })) ?? null;
      verdicts["script away from the root"] =
        (await call("bash", { command: "scripts/pr-context.sh 1" }, tmpdir())) ?? null;
      verdicts["read tool"] = (await call("read", { path: "/mnt/parity-secrets/x" })) ?? null;
      verdicts["write tool"] = (await call("write", { path: ".git/config" })) ?? null;
      return verdicts;
    },
  };
}

/** P9.7: the companion's extensions. Each shim under extensions/cli/ reads the
 * process's env and cwd; the factory takes the same facts as config. */
function companionCases(): Record<string, ParityCase<never>> {
  const dir = mkdtempSync(join(tmpdir(), "qcr-parity-companion-"));
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  const cli = (name: string) => join(ROOT, "extensions", "cli", `${name}.ts`);
  const toolNames = (ext: Extension) => [...ext.tools.keys()].sort();
  // The setup belt builds an engine over the homes the env names; point them at scratch dirs.
  const setupEnv = {
    QCR_ROOT: ROOT,
    QCR_STATE_HOME: join(dir, "state"),
    QCR_CONFIG_HOME: join(dir, "config"),
    QCR_REVIEWED_REPO: join(dir, "reviewed"),
    QCR_TRACKER_DIR: undefined,
    QCR_GITHUB_READ_ENV: undefined,
    OPENVIKING_API_KEY: undefined,
  };
  return {
    "muted-theme": {
      shimPath: cli("muted-theme"),
      env: {},
      config: {} as never,
      factory: () => createMutedTheme(),
    },
    "tui-view": {
      shimPath: cli("tui-view"),
      env: { QCR_FEED_DIR: join(dir, "feed"), QCR_ROOT: undefined },
      config: { feedDir: join(dir, "feed") } as never,
      factory: (c) => createTuiView(c as never),
      resolved: {
        fromEnv: (e) => ({ feedDir: resolveFeedDir(e, process.cwd()) }),
        fromConfig: (c) => c,
      },
      probe: async (ext) => ({
        tools: toolNames(ext),
        // No feed written: both answer the same honest refusal.
        screen: await callTool(ext, "tui_screen", {}),
      }),
    },
    "companion-guard": {
      shimPath: cli("companion-guard"),
      env: { QCR_ROOT: ROOT },
      config: { root: ROOT } as never,
      factory: (c) => createCompanionGuard(c as never),
      resolved: {
        fromEnv: (e) => companionGuardConfigFromEnv(e, process.cwd()),
        fromConfig: (c) => c,
      },
      probe: async (ext) => {
        const guard = ext.handlers.get("tool_call")![0]!;
        const call = (toolName: string, input: Record<string, unknown>) =>
          guard({ type: "tool_call", toolCallId: "t", toolName, input } as never, {} as never);
        return {
          push: await call("bash", { command: "git push origin HEAD" }),
          ghWrite: await call("bash", { command: "gh pr merge 5" }),
          seed: await call("write", { path: "tests/fixtures/seed-manifest.json" }),
          plain: (await call("bash", { command: "git status" })) ?? null,
          source: (await call("write", { path: "src/a.ts" })) ?? null,
        };
      },
    },
    "inject-bridge": {
      shimPath: cli("inject-bridge"),
      env: {
        QCR_INJECT_DIR: join(dir, "inject"),
        QCR_SESSION_NAME: "companion",
        QCR_SESSION_BRIDGE_GENERATION: undefined,
        QCR_SESSION_BRIDGE_STATE_FILE: undefined,
      },
      config: { dir: join(dir, "inject"), session: "companion" } as never,
      factory: (c) => createInjectBridge(c as never),
    },
    onboarding: {
      shimPath: cli("onboarding"),
      env: { QCR_ROOT: ROOT },
      config: { root: ROOT } as never,
      factory: (c) => createOnboarding(c as never),
      probe: async (ext) => toolNames(ext),
    },
    setup: {
      shimPath: cli("setup"),
      env: setupEnv,
      config: { env: { ...process.env, ...setupEnv }, cwd: process.cwd() } as never,
      factory: (c) => createSetup(c as never),
      probe: async (ext) => toolNames(ext),
    },
    lens: {
      shimPath: cli("lens"),
      env: { PI_CODING_AGENT_DIR: join(dir, "agent") },
      config: { ...process.env, PI_CODING_AGENT_DIR: join(dir, "agent") } as never,
      factory: (env) =>
        interactiveLens(env as never, () => process.cwd(), interactiveHostFor(env as never)),
      probe: async (ext) => toolNames(ext),
    },
  };
}

const CASES: Record<string, ParityCase<never>> = {
  ...companionCases(),
  "ledger-pin": ledgerPinCase(),
  "bash-guard": bashGuardCase() as never,
  "finding-clusters": {
    shimPath: join(ROOT, "packages", "pi-plugin", "extensions", "finding-clusters.ts"),
    env: {},
    config: {} as never,
    factory: createFindingClusters,
    resolved: { fromEnv: () => ({}), fromConfig: () => ({}) },
    probe: async (ext) => ({
      cluster: await callTool(ext, "cluster_findings", {
        candidates: [
          { id: "A", path: "a.ts", line: 1, title: "`foo` breaks", lens: "pass-baseline" },
          { id: "B", path: "a.ts", line: 4, title: "`foo` again", lens: "pass-sweep" },
          { id: "C", path: "b.ts", line: 90, title: "unrelated" },
        ],
      }),
      coverage: await callTool(ext, "coverage_gaps", {
        eligible: [
          { path: "q/Dist.java", lines: 40 },
          { path: "q/Other.java", lines: 8 },
        ],
        addressed: ["q/Other.java"],
      }),
    }),
  },
};

/** P3.4: the OpenViking extension. The shim is index.ts's default export; the
 * factory is built from the config the shim resolves for the same env. What pi
 * records (seven hooks, the viking command) and what the uri guard answers
 * must match, and the factory's config must be the one the shim read. */
async function openVikingCase(dir: string): Promise<ParityCase<OpenVikingConfig>> {
  const extDir = join(ROOT, "extensions", "vendor", "openviking-pi");
  const env = {
    OPENVIKING_CREDENTIAL_SOURCE: "env",
    OPENVIKING_CLI_CONFIG_FILE: join(dir, "no-ovcli.conf"),
    OPENVIKING_CONFIG_FILE: join(dir, "no-ov.conf"),
    OPENVIKING_URL: "http://127.0.0.1:9",
    OPENVIKING_API_KEY: "parity-key",
    OPENVIKING_USER: "reviewer",
    OPENVIKING_PENDING_DIR: join(dir, "pending"),
    QCR_OV_SESSION_ID: "pr-1",
  };
  return {
    shimPath: join(extDir, "index.ts"),
    env,
    config: await withEnv(env, async () => openVikingConfigFromProcess(extDir)),
    factory: createOpenViking,
    resolved: {
      fromEnv: () => openVikingConfigFromProcess(extDir),
      fromConfig: (config) => config,
    },
    probe: async (ext) => {
      const guard = ext.handlers.get("tool_call")![0]!;
      const call = (toolName: string, input: Record<string, unknown>) =>
        guard({ type: "tool_call", toolCallId: "t", toolName, input } as never, {} as never);
      return {
        viking: await call("read", { path: "viking://user/reviewer/memories/a.md" }),
        plain: (await call("read", { path: "src/a.ts" })) ?? null,
      };
    },
  };
}

describe("extension factory parity", () => {
  for (const [name, c] of Object.entries(CASES)) {
    it(
      `${name}: shim(env) and factory(config) register the same thing`,
      { timeout: HEAVY_TIMEOUT_MS },
      async () => {
        const shim = await loadShim(c);
        const factory = await loadFactory(c);
        expect(factory.registration).toEqual(shim.registration);
        expect(factory.resolved).toEqual(shim.resolved);
        expect(factory.probe).toEqual(shim.probe);
      },
    );
  }

  it("openviking: shim(env) and createOpenViking(config) register the same thing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qcr-ovparity-"));
    try {
      const c = await openVikingCase(dir);
      const shim = await loadShim(c);
      const factory = await loadFactory(c);
      expect(factory.registration).toEqual(shim.registration);
      expect(factory.resolved).toEqual(shim.resolved);
      expect(factory.probe).toEqual(shim.probe);
      // ...and it is the extension we mean: hooks and command, tools only after connect.
      expect(Object.keys(shim.registration.events)).toEqual([
        "agent_end",
        "before_agent_start",
        "context",
        "session_shutdown",
        "session_start",
        "tool_call",
        "turn_end",
      ]);
      expect(shim.registration.commands).toEqual([
        { name: "viking", description: expect.stringContaining("OpenViking") },
      ]);
      expect((shim.probe as { viking: { block: boolean } }).viking.block).toBe(true);
      expect((shim.resolved as OpenVikingConfig).sessionId).toBe("pr-1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("bash-guard hooks tool_call only, and refuses the /proc reads and the secrets dirs", async () => {
    const factory = await loadFactory(CASES["bash-guard"]!);
    expect(factory.registration.events).toEqual({ tool_call: 1 });
    const verdicts = factory.probe as Record<string, { block?: boolean } | null>;
    expect(verdicts["git status"]).toBeNull();
    for (const denied of [
      "cat /proc/self/environ",
      "head -c 9 /proc/1/mem",
      "cat /mnt/parity-secrets/app_id",
      "cat $HOME/.config/qcr/$QCR_INSTALL/secrets/app.pem",
      "script away from the root",
      "read tool",
      "write tool",
    ])
      expect(verdicts[denied]?.block, denied).toBe(true);
    expect(verdicts["scripts/pr-context.sh 1"]).toBeNull();
  });

  it("finding-clusters registers its two tools, with schemas", async () => {
    const { registration } = await loadShim(CASES["finding-clusters"]!);
    const tools = registration.tools as Array<{ name: string; parameters: { required: string[] } }>;
    expect(tools.map((t) => t.name)).toEqual(["cluster_findings", "coverage_gaps"]);
    expect(tools.map((t) => t.parameters.required)).toEqual([
      ["candidates"],
      ["eligible", "addressed"],
    ]);
  });

  it("ledger-pin hooks turn_end and session_before_compact, and mirrors only the own PR", async () => {
    const c = CASES["ledger-pin"]!;
    const factory = await loadFactory(c);
    expect(factory.registration.events).toEqual({ session_before_compact: 1, turn_end: 1 });
    expect(factory.probe).toEqual({
      afterSibling: null,
      snapshot: "LEDGER PR #42 @ abc\nF1 open\n",
      verdict: null,
    });
  });

  it(
    "each companion shim loads through pi's resource loader and registers what it is for",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const reg = async (name: string) => (await loadShim(CASES[name]!)).registration;
      expect(Object.keys((await reg("muted-theme")).events)).toEqual(["session_start"]);
      const names = (r: Awaited<ReturnType<typeof reg>>) =>
        (r.tools as Array<{ name: string }>).map((t) => t.name);
      expect(names(await reg("tui-view"))).toEqual(["tui_board", "tui_deploy", "tui_screen"]);
      expect((await reg("companion-guard")).events).toEqual({ tool_call: 1 });
      expect(Object.keys((await reg("inject-bridge")).events)).toContain("session_start");
      expect(names(await reg("onboarding"))).toEqual(
        expect.arrayContaining(["onboard_status", "finish_and_exit"]),
      );
      expect(names(await reg("setup"))).toEqual(
        expect.arrayContaining(["setup_unit_cut_save", "scan_preview"]),
      );
      expect(names(await reg("lens"))).toEqual(["lens", "lens_wave"]);
    },
  );

  it("the harness tells a factory that registers less from its shim", async () => {
    const c = CASES["finding-clusters"]!;
    const short: ParityCase<never> = {
      ...c,
      probe: undefined,
      factory: (): ExtensionFactory => () => {},
    };
    const shim = await loadShim(short);
    const factory = await loadFactory(short);
    expect(factory.registration).not.toEqual(shim.registration);
  });
});
