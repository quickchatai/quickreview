// P3.1: shim(env X) registers the same events, tools and resolved config as
// createX(config X). One case per extension that has a factory; P3.2-P3.4 add
// theirs here. The harness (tests/helpers/extension-parity.ts) runs both sides
// through pi's own extension loader.
import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Extension, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { createFindingClusters } from "../extensions/finding-clusters.js";
import { loadFactory, loadShim, type ParityCase } from "./helpers/extension-parity.js";

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
