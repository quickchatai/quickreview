// P4.2: lens system-prompt parity. The system prompt an SDK lens session sends
// is the one a native lens child sends today.
//
// Today a lens is `pi --mode json -p --no-session --model … --tools …
// --append-system-prompt <file holding the agent's body> "Task: …"` (the native
// subagent extension, extensions/subagents.ts): pi's own base prompt, then the
// body as an addendum, then the context files it finds from the cwd. On the
// SDK route runLens (P4.3) builds the same prompt from data: pi's base (no
// system-prompt override), the D34 context files given to the host, and the
// registry's body in `appendSystemPrompt`.
//
// Both are put in front of one local OpenAI-compatible endpoint (loopback only,
// no model, nothing leaves the machine) and the request bodies they put on the
// wire are compared, so the claim is about bytes the provider would receive and
// not about objects. It runs for every agent buildAgents emits for the VM, the
// bench and the scan builds, so every PASS_ADDENDA addendum composed into a
// body is inside the comparison (and the test checks it is: a body that lost
// its execution policy would otherwise match itself).
//
// Not here: the engine route's own execution-policy wording is a separate
// constant that P4.5 adds. Its diff against the native addendum is pinned in
// that ticket as a reviewed delta; this file pins the native text it is diffed
// against (EXECUTION_POLICY_ADDENDUM stays byte-identical, rule 6).
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildBenchAgents } from "../src/bench/runner.js";
import { loadConfig, type Config } from "../src/config.js";
import { loadBuiltAgents, type LensAgent } from "../src/engine/lens/registry.js";
import { PiHost } from "../src/engine/pisdk.js";
import {
  EXECUTION_POLICY_ADDENDUM,
  PASS_ADDENDA,
  buildAgents,
  configAddenda,
  identityVars,
} from "../src/include.js";
import { lensTuningAddenda, roundAgentModels } from "../src/lenstuning.js";
import { postingPolicyAddenda } from "../src/postingpolicy.js";
import { buildScanAgents } from "../src/setup/scanbuild.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "./helpers/fake-openai.js";
import { useOfflineGuard } from "./pi-canary/harness.js";

useOfflineGuard({ loopback: true });

const ROOT = resolve(import.meta.dirname, "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");
const STUB = join(ROOT, "deploy", "reviewer", "AGENTS.override.md");
const cfg: Config = loadConfig(join(ROOT, "tests", "fixtures", "config.toml"));

/** sha256 of EXECUTION_POLICY_ADDENDUM when P4.2 landed. A deliberate change to
 * the native text is a reseed-class decision: update it with the owner. */
const EXECUTION_POLICY_SHA256 = "6055a7befe1eaeba5ef25cb33c37edd484958aade4b449a3a016f68b53257d1f";

const tmp = mkdtempSync(join(tmpdir(), "lens-prompt-parity-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

// ---- the three builds, as the routes make them --------------------------------

/** Which context files a build's lenses load (tests/context-files.test.ts): the
 * VM and bench lenses load the reviewer stub, scan leaves load none. */
interface Build {
  name: "vm" | "bench" | "scan";
  dir: string;
  context: boolean;
}
const builds: Build[] = [
  { name: "vm", dir: join(tmp, "vm"), context: true },
  { name: "bench", dir: join(tmp, "bench"), context: true },
  { name: "scan", dir: join(tmp, "scan"), context: false },
];

// The VM's build, as wire.ts composes it (memory tools on).
buildAgents(join(ROOT, "agents"), builds[0]!.dir, {
  root: ROOT,
  tiers: cfg.models.tiers,
  riskPasses: cfg.models.risk_passes,
  validateTier: cfg.models.validate_tier,
  vars: identityVars(cfg),
  models: roundAgentModels(cfg),
  addenda: [
    ...PASS_ADDENDA,
    ...configAddenda(cfg.review),
    ...lensTuningAddenda(cfg.lenses),
    ...postingPolicyAddenda(cfg.posting),
  ],
});
buildBenchAgents(ROOT, cfg, builds[1]!.dir);
buildScanAgents(ROOT, builds[2]!.dir, cfg);

// ---- the two sides --------------------------------------------------------------

let server: FakeOpenAI;
let host: PiHost;
const stubbed = join(tmp, "with-stub", "w");
const bare = join(tmp, "no-stub", "w");
beforeAll(async () => {
  server = await startFakeOpenAI();
  writeFakeProvider(join(tmp, "agent-cli"), server.baseUrl);
  writeFakeProvider(join(tmp, "agent-sdk"), server.baseUrl);
  // Two cwds the lenses run in: one holding the reviewer stub where pi looks
  // for it, one with no context file anywhere above it.
  mkdirSync(stubbed, { recursive: true });
  mkdirSync(bare, { recursive: true });
  copyFileSync(STUB, join(stubbed, "AGENTS.override.md"));
  host = await PiHost.create({ agentDir: join(tmp, "agent-sdk") });
});
afterAll(async () => {
  host.dispose();
  await server.close();
});

const cwdOf = (b: Build) => (b.context ? stubbed : bare);
const answers = (n: number) => server.script(Array.from({ length: n }, () => ({ text: "ok" })));

/** The flags the native extension's child gets, plus the switches that stop it
 * discovering extensions, skills, prompts and themes (the SDK host discovers
 * none), so the two see the same things. The model, tools and body come from
 * the agent. */
const CLI_FLAGS = ["--mode", "json", "-p", "--no-session", "-ne", "-ns", "-np", "--no-themes"];

function requestFor(task: string): string {
  const req = server.requests.find((r) => r.body.includes(`Task: ${task}#`));
  if (!req) throw new Error(`no request carried task ${task}`);
  return req.body;
}

function cliRequest(b: Build, a: LensAgent, task: string): Promise<string> {
  const bodyFile = join(tmp, `body-${a.name}-${b.name}.md`);
  // The native extension writes `agent.systemPrompt` (the trimmed body) as is.
  writeFileSync(bodyFile, a.body, "utf8");
  const args = [
    ...CLI_FLAGS,
    ...(b.context ? [] : ["--no-context-files"]),
    "--model",
    FAKE_MODEL,
    "--tools",
    (a.tools ?? []).join(","),
    "--append-system-prompt",
    bodyFile,
    `Task: ${task}#`,
  ];
  return new Promise((done, fail) => {
    const child = execFile(
      PI_BIN,
      args,
      {
        cwd: cwdOf(b),
        timeout: 60_000,
        env: {
          PATH: process.env["PATH"],
          HOME: join(tmp, "home"),
          PI_CODING_AGENT_DIR: join(tmp, "agent-cli"),
          PI_OFFLINE: "1",
          PI_TELEMETRY: "0",
        },
      },
      (err, _stdout, stderr) => {
        if (err) return fail(new Error(`pi child for ${a.name} failed: ${err.message}\n${stderr}`));
        try {
          done(requestFor(task));
        } catch (e) {
          fail(e as Error);
        }
      },
    );
    // `-p` reads a piped stdin to its end before it starts.
    child.stdin?.end();
  });
}

async function sdkRequest(b: Build, a: LensAgent, task: string): Promise<string> {
  const session = await host.makeSession({
    cwd: cwdOf(b),
    env: { PATH: process.env["PATH"], HOME: join(tmp, "home") },
    model: FAKE_MODEL,
    tools: a.tools ?? [],
    appendSystemPrompt: [a.body],
    agentsFiles: b.context
      ? [{ path: join(cwdOf(b), "AGENTS.override.md"), content: readFileSync(STUB, "utf8") }]
      : [],
  });
  try {
    await session.prompt(`Task: ${task}#`);
  } finally {
    session.dispose();
  }
  return requestFor(task);
}

/** A request body as a value, without the fields that name the session (it
 * keys the provider's prompt cache and differs per session by construction). */
function stable(body: string): unknown {
  const o = JSON.parse(body) as Record<string, unknown>;
  for (const k of ["prompt_cache_key", "user", "session_id"]) delete o[k];
  return o;
}

function systemText(body: string): string {
  const first = (JSON.parse(body) as { messages: { role: string; content: unknown }[] })
    .messages[0]!;
  expect(["system", "developer"]).toContain(first.role);
  return typeof first.content === "string" ? first.content : JSON.stringify(first.content);
}

/** Where two prompts first differ, with a little context. */
function firstDifference(a: string, b: string): string {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const show = (s: string) => JSON.stringify(s.slice(Math.max(0, i - 40), i + 80));
  return `differ at ${i} (cli ${a.length} chars, sdk ${b.length}): cli ${show(a)} vs sdk ${show(b)}`;
}

// ---- the cases: one per distinct body and tool list in a build ------------------

function distinct(b: Build): LensAgent[] {
  const seen = new Map<string, LensAgent>();
  for (const a of loadBuiltAgents(b.dir).agents.values()) {
    const key = createHash("sha1")
      .update(a.body)
      .update("\0")
      .update((a.tools ?? []).join(","))
      .digest("hex");
    if (!seen.has(key)) seen.set(key, a);
  }
  return [...seen.values()].sort((x, y) => (x.name < y.name ? -1 : 1));
}

describe("every built agent: the SDK lens prompt is the native --append-system-prompt prompt", () => {
  it("the tiers of one pass share a body, so one case stands for its tiers", () => {
    for (const b of builds) {
      const byPass = new Map<string, Set<string>>();
      for (const a of loadBuiltAgents(b.dir).agents.values()) {
        const pass = a.name.slice(0, a.name.indexOf("--"));
        byPass.set(pass, (byPass.get(pass) ?? new Set()).add(a.body));
      }
      expect(byPass.size, b.name).toBeGreaterThan(10);
      for (const [pass, bodies] of byPass) expect(bodies.size, `${b.name}/${pass}`).toBe(1);
    }
  });

  it("the bodies carry the composed addenda, so the comparison is not vacuous", () => {
    for (const b of builds) {
      expect(distinct(b).length, b.name).toBeGreaterThan(10);
      for (const a of loadBuiltAgents(b.dir).agents.values()) {
        expect(a.body, `${b.name}/${a.name}`).toContain(EXECUTION_POLICY_ADDENDUM.trim());
      }
    }
  });

  for (const b of builds) {
    it(`${b.name}: the requests are equal for every distinct agent`, async () => {
      const cases = distinct(b);
      answers(cases.length * 4);
      const failures: string[] = [];
      // A few pi children at a time: each is a process start.
      const queue = [...cases];
      const worker = async () => {
        for (let a = queue.shift(); a; a = queue.shift()) {
          const label = `${b.name}/${a.name}`;
          const [cli, sdk] = await Promise.all([
            cliRequest(b, a, `cli ${label}`),
            sdkRequest(b, a, `sdk ${label}`),
          ]);
          // The two tasks differ only in who ran them; compare with that masked.
          const cliBody = cli.split(`cli ${label}`).join("<task>");
          const sdkBody = sdk.split(`sdk ${label}`).join("<task>");
          const [cs, ss] = [systemText(cliBody), systemText(sdkBody)];
          if (cs !== ss) failures.push(`${label}: system prompt ${firstDifference(cs, ss)}`);
          else if (!cs.includes(a.body)) failures.push(`${label}: the body is not in the prompt`);
          else if (JSON.stringify(stable(cliBody)) !== JSON.stringify(stable(sdkBody)))
            failures.push(`${label}: the system prompts match but the requests differ`);
        }
      };
      await Promise.all([worker(), worker(), worker(), worker()]);
      expect(failures).toEqual([]);
    }, 600_000);
  }

  it("the context files ride as data: the stub with the VM build, nothing with scan leaves", async () => {
    answers(4);
    const [vm, scan] = [builds[0]!, builds[2]!];
    const withStub = await sdkRequest(vm, distinct(vm)[0]!, "sdk probe-vm");
    const without = await sdkRequest(scan, distinct(scan)[0]!, "sdk probe-scan");
    expect(systemText(withStub)).toContain("AGENTS.override.md");
    expect(systemText(without)).not.toContain("AGENTS.override.md");
  });
});

describe("the native execution policy the engine wording is diffed against", () => {
  it("stays byte-identical (rule 6): the native build is not edited for the engine route", () => {
    expect(createHash("sha256").update(EXECUTION_POLICY_ADDENDUM).digest("hex")).toBe(
      EXECUTION_POLICY_SHA256,
    );
  });
});
