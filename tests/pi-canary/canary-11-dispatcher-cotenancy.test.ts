// Canary 11 : the SDK host shares the process's HTTP dispatcher and never
// fights over it.
//
// Two shapes. Inside a CLI pi (the debug round, the companion) pi installed its
// own dispatcher at startup, so a PiHost created there must leave it, and
// fetch, exactly as they are, whatever the route claims about owning the
// process. In `qcr review` the host owns the process: it installs pi's
// dispatcher once, and the Node GitHub fetches that follow ride the same one;
// a second host does not install again.
//
// Evidence is behavioural: the dispatcher in force is told apart by its idle
// timeout, observed against a loopback server (undici checks header timers on a
// one-second tick, so the delays are well clear of it).
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import {
  PiHost,
  UNDICI_GLOBAL_DISPATCHER,
  insideCliPi,
  loadConfigureHttpDispatcher,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { saveDispatcherState } from "../helpers/dispatcher-state.js";
import { createHostRig, useOfflineGuard } from "./harness.js";

useOfflineGuard({ loopback: true });

const state = saveDispatcherState();
beforeAll(() => state.prime());
const g = globalThis as Record<symbol, unknown>;
let server: Server;
let base: string;
let tmpRoot: string;
const hosts: PiHost[] = [];

beforeEach(async () => {
  state.reset();
  tmpRoot = mkdtempSync(join(tmpdir(), "canary11-"));
  server = createServer((req, res) => {
    const ms = Number(new URL(req.url ?? "/", "http://x").searchParams.get("ms") ?? 0);
    setTimeout(() => {
      res.writeHead(200);
      res.end("ok");
    }, ms);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  for (const h of hosts.splice(0)) h.dispose();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(tmpRoot, { recursive: true, force: true });
});

afterAll(() => state.restore());

const newHost = async (
  name: string,
  o: Parameters<typeof PiHost.create>[0] extends infer T ? Partial<T> : never,
) => {
  const host = await PiHost.create({ agentDir: join(tmpRoot, name), ...o });
  hosts.push(host);
  return host;
};

async function fetchFailure(path: string): Promise<string | undefined> {
  try {
    await (await fetch(`${base}${path}`)).text();
    return undefined;
  } catch (e) {
    return String((e as { cause?: { code?: string } }).cause?.code ?? e);
  }
}

/** What a CLI pi does at startup: set its title and flag, install its dispatcher. */
async function startFakeCliPi(idleTimeoutMs: number): Promise<void> {
  process.title = "pi";
  process.env["PI_CODING_AGENT"] = "true";
  (await loadConfigureHttpDispatcher())(idleTimeoutMs);
}

describe("[canary 11] inside a CLI pi the host leaves pi's dispatcher alone", () => {
  it("an owning route finds it, reports reused, and changes neither the dispatcher nor fetch", async () => {
    await startFakeCliPi(300);
    const cliDispatcher = g[UNDICI_GLOBAL_DISPATCHER];
    const cliFetch = globalThis.fetch;
    const host = await newHost("a", { ownsProcess: true, httpIdleTimeoutMs: 5000 });
    expect(host.dispatcher).toBe("reused");
    expect(g[UNDICI_GLOBAL_DISPATCHER]).toBe(cliDispatcher);
    expect(globalThis.fetch).toBe(cliFetch);
    // pi's 300 ms is still the one in force, not the host's 5000.
    expect(await fetchFailure("/?ms=1800")).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  it("so does a route that does not claim the process", async () => {
    await startFakeCliPi(300);
    const cliDispatcher = g[UNDICI_GLOBAL_DISPATCHER];
    const host = await newHost("b", { ownsProcess: false });
    expect(host.dispatcher).toBe("reused");
    expect(g[UNDICI_GLOBAL_DISPATCHER]).toBe(cliDispatcher);
  });

  it("and its sessions run inside the CLI pi", async () => {
    await startFakeCliPi(300);
    const rig = await createHostRig({ ownsProcess: true });
    try {
      expect(rig.host.dispatcher).toBe("reused");
      const session = await rig.host.makeSession({
        cwd: rig.dir,
        env: {},
        model: rig.faux.getModel(),
        tools: [],
      });
      rig.faux.setResponses([fauxAssistantMessage("hello from inside")]);
      await session.prompt("go");
      expect(session.getLastAssistantText()).toBe("hello from inside");
    } finally {
      rig.close();
    }
  });
});

describe("[canary 11] a flag inherited from a pi bash call is not a CLI pi", () => {
  it("an owning route in a child of pi installs pi's dispatcher", async () => {
    // pi's bash tool passes PI_CODING_AGENT to its children; the title is per process.
    process.env["PI_CODING_AGENT"] = "true";
    expect(insideCliPi()).toBe(false);
    expect(await fetchFailure("/?ms=1800")).toBeUndefined();
    const host = await newHost("a", { ownsProcess: true, httpIdleTimeoutMs: 300 });
    expect(host.dispatcher).toBe("installed");
    expect(await fetchFailure("/?ms=1800")).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  it("a route that does not claim the process still installs nothing", async () => {
    process.env["PI_CODING_AGENT"] = "true";
    const before = g[UNDICI_GLOBAL_DISPATCHER];
    const host = await newHost("b", { ownsProcess: false });
    expect(host.dispatcher).toBe("none");
    expect(g[UNDICI_GLOBAL_DISPATCHER]).toBe(before);
  });

  it("the rpc entry's title counts as a CLI pi too", () => {
    expect(insideCliPi({ PI_CODING_AGENT: "true" }, "pi-rpc")).toBe(true);
    expect(insideCliPi({ PI_CODING_AGENT: "true" }, "node")).toBe(false);
    expect(insideCliPi({}, "pi")).toBe(false);
  });
});

describe("[canary 11] in qcr review the host owns the process and shares one dispatcher", () => {
  it("installs pi's dispatcher once; Node fetches (GitHub's) ride it; a second host adds none", async () => {
    // Before any host: Node's default, no short timeout.
    expect(await fetchFailure("/?ms=1800")).toBeUndefined();

    const first = await newHost("first", { ownsProcess: true, httpIdleTimeoutMs: 300 });
    expect(first.dispatcher).toBe("installed");
    const installed = g[UNDICI_GLOBAL_DISPATCHER];
    expect(installed).toBeDefined();
    // The GitHub fetch is a plain global fetch, and it sits behind the host's dispatcher.
    expect(await fetchFailure("/?ms=1800")).toBe("UND_ERR_HEADERS_TIMEOUT");

    const second = await newHost("second", { ownsProcess: true, httpIdleTimeoutMs: 5000 });
    expect(second.dispatcher).toBe("installed");
    expect(g[UNDICI_GLOBAL_DISPATCHER]).toBe(installed);
    // No second install: the first host's 300 ms still governs, not the second's 5000.
    expect(await fetchFailure("/?ms=1800")).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  it("a dispatcher someone replaced after the host's install is left in place", async () => {
    const first = await newHost("first", { ownsProcess: true, httpIdleTimeoutMs: 300 });
    expect(first.dispatcher).toBe("installed");
    const replacement = { dispatch: () => false, close: async () => {}, destroy: async () => {} };
    g[UNDICI_GLOBAL_DISPATCHER] = replacement;
    const second = await newHost("second", { ownsProcess: true });
    expect(second.dispatcher).toBe("reused");
    expect(g[UNDICI_GLOBAL_DISPATCHER]).toBe(replacement);
  });
});
