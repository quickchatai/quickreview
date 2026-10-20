// Canary 10, full [P5.2]: the one-shot main session's provider request on the SDK
// route is byte-equal to the process route's.
//
// canary-10-bare pins a BARE session. This one runs the review round itself
// (src/engine/round.ts runRound) on both runtimes, over the SAME local
// OpenAI-compatible endpoint, and compares the raw request bodies off the wire:
//
//   - the system prompt the round writes, plus pi's own
//   - the D34 context files: the reviewer stub, found in the cwd by the pi child
//     and handed to the SDK session as data
//   - the tools: pi's four, the factory-registered ones (cluster_findings,
//     coverage_gaps) and the lens tool schemas
//
// The lens tool slot holds today's native extension (extensions/subagents.ts:
// `subagent`, `launch_plan`), loaded as a file by the child and as a factory by
// the SDK session. The engine's own lens tools (P4.5) take the slot and must
// keep this test green. The follow-up turn is compared too: the child's
// `--continue` respawn and the SDK session's second turn send the same body.
//
// Nothing leaves loopback and no model runs.
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import subagents from "../../extensions/subagents.js";
import { PiHost } from "../../src/engine/pisdk.js";
import type { Runtime, RuntimeSession, SessionSpec } from "../../src/engine/port.js";
import { piCliRuntime } from "../helpers/pi-cli-runtime.js";
import { runRound, type RoundSpec } from "../../src/engine/round.js";
import { roundSdkExtras } from "../../src/engine/roundsdk.js";
import { sdkRuntime } from "../../src/engine/sdkruntime.js";
import { HOST_CONTEXT_STUB, REVIEWER_STUB } from "../../src/hostroute.js";
import type { OneShotPrompts } from "../../src/engine/prompts.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
  type RecordedRequest,
} from "../helpers/fake-openai.js";
import { FILES, FIXTURE_CONFIG, TARGET, mkRoot, mkTree } from "../helpers/round-rig.js";
import { useOfflineGuard } from "./harness.js";

vi.stubEnv("QCR_CONFIG", FIXTURE_CONFIG);
const { benchConfig } = await import("../../src/bench/runner.js");
const { ecosystemFor } = await import("../../src/ecosystem.js");
const { renderOneShotPrompts } = await import("../../src/engine/prompts.js");

useOfflineGuard({ loopback: true });

const ROOT = resolve(import.meta.dirname, "..", "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");

let server: FakeOpenAI;
beforeAll(async () => {
  server = await startFakeOpenAI();
});
afterAll(async () => {
  await server.close();
  vi.unstubAllEnvs();
});

let dir: string;
let host: PiHost;
let rig: {
  root: string;
  cwd: string;
  tree: string;
  outDir: string;
  prompts: OneShotPrompts;
};
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-canary-10-round-"));
  server.requests.length = 0;
  writeFakeProvider(join(dir, "agent-cli"), server.baseUrl);
  writeFakeProvider(join(dir, "agent-sdk"), server.baseUrl);
  host = await PiHost.create({ agentDir: join(dir, "agent-sdk") });
  const root = mkRoot(dir, "root");
  const tree = mkTree(dir, "tree");
  const outDir = join(dir, "out");
  // The reviewer stub where the pi child looks for a context file (the host
  // route's per-run cwd, outside every checkout); the SDK session is handed it
  // as data at the same path.
  const cwd = join(dir, "work");
  mkdirSync(cwd);
  copyFileSync(join(ROOT, REVIEWER_STUB), join(cwd, HOST_CONTEXT_STUB));
  const cfg = benchConfig("");
  cfg.models.conversation = FAKE_MODEL;
  rig = {
    root,
    cwd,
    tree,
    outDir,
    prompts: renderOneShotPrompts({
      root,
      cfg,
      ecosystem: ecosystemFor("none"),
      target: TARGET,
      tree,
      caseDir: outDir,
      files: FILES,
      issuedAt: "2026-10-19T00:00:00.000Z",
    }),
  };
});
afterEach(() => {
  host.dispose();
  for (const [k, v] of stubbed) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  stubbed.clear();
  rmSync(dir, { recursive: true, force: true });
});

/** The pi child never goes looking for a network: the in-process guard cannot
 * see a child, so the child is told. */
function offline(rt: Runtime): Runtime {
  const add = (s: SessionSpec): SessionSpec => ({
    ...s,
    env: { ...s.env, PI_OFFLINE: "1", PI_TELEMETRY: "0" },
  });
  return { create: (s) => rt.create(add(s)), resume: (f, s) => rt.resume(f, add(s)) };
}

/** The process env as it was before a session put the round's QCR_* names in it. */
const stubbed = new Map<string, string | undefined>();

/** The native lens extension as a factory. It reads its settings from the
 * process env (the child's env is the round's), so they are put there for the
 * session's life: what a route hosting it would do. */
function nativeLens(spec: SessionSpec): ExtensionFactory {
  for (const [k, v] of Object.entries(spec.env)) {
    if (!(k.startsWith("QCR_") || k === "PI_CODING_AGENT_DIR") || v === undefined) continue;
    if (!stubbed.has(k)) stubbed.set(k, process.env[k]);
    process.env[k] = v;
  }
  return subagents as unknown as ExtensionFactory;
}

function sdkOneShotRuntime(): Runtime {
  return sdkRuntime(host, {
    extras: (spec) =>
      roundSdkExtras({
        lens: { factories: [nativeLens(spec)], toolNames: ["subagent", "launch_plan"] },
      })(spec),
  });
}

interface Run {
  requests: RecordedRequest[];
  /** The main session's id, read once the round is over. */
  id: string;
}

/** One round on `kind`'s runtime and the requests it put on the wire. */
async function round(kind: "proc" | "sdk"): Promise<Run> {
  server.script([{ text: "ok" }, { text: "ok" }]);
  const before = server.requests.length;
  const cfg = benchConfig("");
  cfg.models.conversation = FAKE_MODEL;
  // One root, tree, out dir and rendering for both runs: their paths and the
  // issue time are part of the request, and are not what this canary compares.
  const spec: RoundSpec = {
    root: rig.root,
    cwd: rig.cwd,
    // The native lens tool's description names the agent dir it reads from: the
    // child's PI_CODING_AGENT_DIR, the host process's env on the SDK route.
    agentDir: join(dir, "agent-cli"),
    tree: rig.tree,
    files: FILES,
    target: TARGET,
    outDir: rig.outDir,
    cfg,
    ecosystem: ecosystemFor("none"),
    timeoutMs: 10 * 60_000,
    prompts: rig.prompts,
  };
  const runtime = kind === "proc" ? offline(piCliRuntime({ bin: PI_BIN })) : sdkOneShotRuntime();
  let main: RuntimeSession | undefined;
  const result = await runRound(spec, {
    create: async (s) => (main = await runtime.create(s)),
    resume: (f, s) => runtime.resume(f, s),
  });
  // The continuation ran: the fake model wrote none of the round's outputs.
  expect(result.continued, `${kind}: ${result.error ?? ""}`).toBe(true);
  const requests = server.requests.slice(before);
  expect(requests.length, kind).toBe(2);
  return { requests, id: main!.id };
}

const masked = (body: string, id: string): string => body.split(id).join("<session-id>");

describe("[canary 10, full] the one-shot SDK request == the process route's", () => {
  it("system prompt, D34 context files, factory tools, lens tools: the first request", async () => {
    const proc = await round("proc");
    const sdk = await round("sdk");
    const a = proc.requests[0]!.body;
    const b = sdk.requests[0]!.body;
    const body = JSON.parse(a) as {
      messages: { role: string; content: string }[];
      tools: unknown[];
    };
    // The comparison is not vacuous.
    const text = JSON.stringify(body);
    expect(text).toContain("AGENTS.override.md");
    for (const tool of ["bash", "subagent", "launch_plan", "cluster_findings", "coverage_gaps"])
      expect(text, tool).toContain(`"name":"${tool}"`);
    expect(masked(b, sdk.id)).toBe(masked(a, proc.id));
  });

  it("the follow-up turn: `--continue` respawn and second live turn send the same body", async () => {
    const proc = await round("proc");
    const sdk = await round("sdk");
    expect(masked(sdk.requests[1]!.body, sdk.id)).toBe(masked(proc.requests[1]!.body, proc.id));
  });
});
