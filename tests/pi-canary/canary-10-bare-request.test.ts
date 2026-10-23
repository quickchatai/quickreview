// Canary 10 (bare): a bare SDK session's provider request is byte-equal to
// a CLI pi started with the same flags.
//
// The route's parity claim ("the SDK route reviews the way the CLI route does")
// starts at the request: the system prompt (pi's own text, the reviewer stub as
// a context file, a system-prompt file when the spec names one) and the
// built-in tool schemas. Both runtimes are put in front of the SAME local
// OpenAI-compatible endpoint, so the comparison is of raw request bodies off the
// wire, not of objects: a real `pi` child through piCliRuntime, and the SDK
// in this process through sdkRuntime. Nothing leaves loopback and no model runs.
//
// Full parity with our factories and lens tools: canary-10-oneshot-request
// and canary-10-bot-request.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import type { SessionSpec } from "@quickchatai/pi-quickreview/src/engine/port.js";
import { piCliRuntime } from "../helpers/pi-cli-runtime.js";
import { sdkRuntime } from "@quickchatai/pi-quickreview/src/engine/sdkruntime.js";
import {
  FAKE_MODEL,
  startFakeOpenAI,
  writeFakeProvider,
  type FakeOpenAI,
} from "../helpers/fake-openai.js";
import { useOfflineGuard } from "./harness.js";

useOfflineGuard({ loopback: true });

const ROOT = resolve(import.meta.dirname, "..", "..");
const PI_BIN = join(ROOT, "node_modules", ".bin", "pi");
const STUB = join(ROOT, "deploy", "reviewer", "AGENTS.override.md");

let server: FakeOpenAI;
beforeAll(async () => {
  server = await startFakeOpenAI();
});
afterAll(() => server.close());

let dir: string;
let host: PiHost;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "pi-canary-10-"));
  server.requests.length = 0;
  server.script([{ text: "ok" }, { text: "ok" }]);
  writeFakeProvider(join(dir, "agent-cli"), server.baseUrl);
  writeFakeProvider(join(dir, "agent-sdk"), server.baseUrl);
  // The cwd both sessions run in, holding the reviewer stub where pi looks.
  mkdirSync(join(dir, "work"));
  copyFileSync(STUB, join(dir, "work", "AGENTS.override.md"));
  host = await PiHost.create({ agentDir: join(dir, "agent-sdk") });
});
afterEach(() => {
  host.dispose();
  rmSync(dir, { recursive: true, force: true });
});

const files = (name: string) => ({
  eventsFile: join(dir, `${name}-events.jsonl`),
  stderrFile: join(dir, `${name}-stderr.log`),
});

function spec(name: string, over: Partial<SessionSpec> = {}): SessionSpec {
  return {
    cwd: join(dir, "work"),
    env: {
      PATH: process.env["PATH"],
      HOME: join(dir, "home"),
      PI_OFFLINE: "1",
      PI_TELEMETRY: "0",
    },
    model: FAKE_MODEL,
    ...files(name),
    limits: { timeoutMs: 60_000 },
    ...over,
  };
}

/** The request a runtime's first turn put on the wire. */
async function firstRequest(kind: "cli" | "sdk", over: Partial<SessionSpec> = {}) {
  const before = server.requests.length;
  const rt = kind === "cli" ? piCliRuntime({ bin: PI_BIN }) : sdkRuntime(host);
  const s = await rt.create(
    kind === "cli"
      ? spec(kind, {
          env: { ...spec(kind).env, PI_CODING_AGENT_DIR: join(dir, "agent-cli") },
          cliFlags: ["-ne", "-ns", "-np", "--no-themes"],
          ...over,
        })
      : spec(kind, {
          // The SDK takes the context file as data, at the path pi would have read it from.
          agentsFiles: [
            { path: join(dir, "work", "AGENTS.override.md"), content: readFileSync(STUB, "utf8") },
          ],
          ...over,
        }),
  );
  const r = await s.prompt("Review this.");
  await s.dispose();
  expect(r.code, readFileSync(join(dir, `${kind}-stderr.log`), "utf8")).toBe(0);
  expect(server.requests.length).toBe(before + 1);
  return { request: server.requests[before]!, id: s.id };
}

/** A request body with the session's own id masked: it keys the provider's
 * prompt cache and differs per session by construction. */
const masked = (body: string, id: string): string => body.split(id).join("<session-id>");

describe("[canary 10, bare] SDK request == CLI request", () => {
  it("the default prompt, the reviewer stub as a context file, and pi's four tools", async () => {
    const cli = await firstRequest("cli");
    const sdk = await firstRequest("sdk");
    const body = JSON.parse(cli.request.body) as { messages: { role: string; content: string }[] };
    // The comparison is not vacuous: the stub and the tool schemas are in it.
    expect(cli.request.body).toContain("AGENTS.override.md");
    expect(JSON.stringify(body)).toContain('"name":"bash"');
    expect(masked(sdk.request.body, sdk.id)).toBe(masked(cli.request.body, cli.id));
  });

  it("a system-prompt file and a narrowed tool list", async () => {
    writeFileSync(join(dir, "system.md"), "You review diffs.\nBe brief.\n");
    const over = { systemPromptFile: join(dir, "system.md"), tools: ["read", "grep", "ls"] };
    const cli = await firstRequest("cli", over);
    const sdk = await firstRequest("sdk", over);
    expect(cli.request.body).toContain("You review diffs.");
    expect(JSON.parse(cli.request.body).tools).toHaveLength(3);
    expect(masked(sdk.request.body, sdk.id)).toBe(masked(cli.request.body, cli.id));
  });
});
