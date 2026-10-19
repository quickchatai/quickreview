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
import { createFindingClusters } from "../extensions/finding-clusters.js";
import { createLedgerPin, ledgerPinConfigFromEnv } from "../extensions/ledger-pin.js";
import { loadFactory, loadShim, type ParityCase } from "./helpers/extension-parity.js";

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
  const config = { session: "pr-42", prMeta: "PR #42 parity", ownPr: 42, snapshotPath };
  const message = (text: string) => ({
    message: { role: "assistant", content: [{ type: "text", text }] },
    toolResults: [],
  });
  return {
    shimPath: join(ROOT, "extensions", "ledger-pin.ts"),
    env,
    config: config as never,
    factory: (c) => createLedgerPin(c as never),
    resolved: {
      fromEnv: (e) => ledgerPinConfigFromEnv(e),
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

const CASES: Record<string, ParityCase<never>> = {
  "ledger-pin": ledgerPinCase(),
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
