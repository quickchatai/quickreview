// P3.1: shim(env X) registers the same events, tools and resolved config as
// createX(config X). One case per extension that has a factory; P3.2-P3.4 add
// theirs here. The harness (tests/helpers/extension-parity.ts) runs both sides
// through pi's own extension loader.
import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extension, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFindingClusters } from "../extensions/finding-clusters.js";
import { createOpenViking } from "../extensions/vendor/openviking-pi/index.js";
import {
  openVikingConfigFromProcess,
  type OpenVikingConfig,
} from "../extensions/vendor/openviking-pi/qcr-shim.js";
import { loadFactory, loadShim, withEnv, type ParityCase } from "./helpers/extension-parity.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Calls a registered tool the way pi would, and answers its text. */
async function callTool(ext: Extension, name: string, params: Record<string, unknown>) {
  const def = ext.tools.get(name)!.definition;
  const res = await def.execute("probe", params as never, undefined, undefined, {} as never);
  return res.content.map((c) => (c.type === "text" ? c.text : ""));
}

const CASES: Record<string, ParityCase<never>> = {
  "finding-clusters": {
    shimPath: join(ROOT, "extensions", "finding-clusters.ts"),
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
    it(`${name}: shim(env) and factory(config) register the same thing`, async () => {
      const shim = await loadShim(c);
      const factory = await loadFactory(c);
      expect(factory.registration).toEqual(shim.registration);
      expect(factory.resolved).toEqual(shim.resolved);
      expect(factory.probe).toEqual(shim.probe);
    });
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

  it("finding-clusters registers its two tools, with schemas", async () => {
    const { registration } = await loadShim(CASES["finding-clusters"]!);
    const tools = registration.tools as Array<{ name: string; parameters: { required: string[] } }>;
    expect(tools.map((t) => t.name)).toEqual(["cluster_findings", "coverage_gaps"]);
    expect(tools.map((t) => t.parameters.required)).toEqual([
      ["candidates"],
      ["eligible", "addressed"],
    ]);
  });

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
