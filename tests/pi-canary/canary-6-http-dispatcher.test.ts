// Canary 6: pi's HTTP dispatcher, as the SDK host installs it.
//
// pi does not export configureHttpDispatcher; PiHost deep-imports it by file
// path so an SDK host runs provider requests through exactly the dispatcher the
// CLI would. That is only safe while the pinned pi keeps the function, its
// timeout semantics and its global effect, so this holds all three: the function
// is where the deep import looks, an install puts a dispatcher in undici's global
// slot with the idle timeout applied to response headers, and PiHost hands it the
// host's configured timeout. A pi bump that moves or reshapes any of it
// fails here, not in a run.
//
// The timeout is observed against a loopback server (loopback is the one network
// the offline guard lets through); nothing leaves the machine. undici checks its
// header timers on a one-second tick, so a short timeout fires at about one
// second: the cases below use delays well clear of that.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_HTTP_IDLE_TIMEOUT_MS,
  PiHost,
  UNDICI_GLOBAL_DISPATCHER,
  ensureHttpDispatcher,
  loadConfigureHttpDispatcher,
} from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { saveDispatcherState } from "../helpers/dispatcher-state.js";
import { useOfflineGuard } from "./harness.js";

useOfflineGuard({ loopback: true });

const state = saveDispatcherState();
beforeAll(() => state.prime());
const g = globalThis as Record<symbol, unknown>;
let server: Server;
let base: string;
let tmpRoot: string;

beforeEach(async () => {
  state.reset();
  tmpRoot = mkdtempSync(join(tmpdir(), "canary6-"));
  server = createServer((req, res) => {
    // /slow-headers?ms=N answers its headers only after N ms.
    const ms = Number(new URL(req.url ?? "/", "http://x").searchParams.get("ms") ?? 0);
    setTimeout(() => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    }, ms);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  rmSync(tmpRoot, { recursive: true, force: true });
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

afterAll(() => state.restore());

async function fetchFailure(url: string): Promise<string | undefined> {
  try {
    await (await fetch(url)).text();
    return undefined;
  } catch (e) {
    return String((e as { cause?: { code?: string } }).cause?.code ?? e);
  }
}

describe("[canary 6] pi's configureHttpDispatcher, deep-imported", () => {
  it("is exactly where PiHost looks, and is a function", async () => {
    expect(typeof (await loadConfigureHttpDispatcher())).toBe("function");
  });

  it("an install puts a dispatcher in undici's global slot, once", async () => {
    const nodeDefault = g[UNDICI_GLOBAL_DISPATCHER];
    expect(await ensureHttpDispatcher({ ownsProcess: true, idleTimeoutMs: 5000 })).toBe(
      "installed",
    );
    const installed = g[UNDICI_GLOBAL_DISPATCHER];
    expect(installed).toBeDefined();
    expect(installed).not.toBe(nodeDefault);
    // A second ask from the same process shares it.
    expect(await ensureHttpDispatcher({ ownsProcess: true, idleTimeoutMs: 1 })).toBe("installed");
    expect(g[UNDICI_GLOBAL_DISPATCHER]).toBe(installed);
  });

  it("a route that does not own the process installs nothing", async () => {
    const before = g[UNDICI_GLOBAL_DISPATCHER];
    expect(await ensureHttpDispatcher({ ownsProcess: false, idleTimeoutMs: 5000 })).toBe("none");
    expect(g[UNDICI_GLOBAL_DISPATCHER]).toBe(before);
  });

  it("the idle timeout is the response-headers timeout: a slow answer fails past it, not within it", async () => {
    await ensureHttpDispatcher({ ownsProcess: true, idleTimeoutMs: 300 });
    expect(await fetchFailure(`${base}/?ms=1800`)).toBe("UND_ERR_HEADERS_TIMEOUT");
    expect(await fetchFailure(`${base}/?ms=0`)).toBeUndefined();
  });

  it("a longer timeout lets the same slow answer through", async () => {
    await ensureHttpDispatcher({ ownsProcess: true, idleTimeoutMs: 5000 });
    expect(await fetchFailure(`${base}/?ms=1800`)).toBeUndefined();
  });

  it("PiHost passes its configured timeout, and defaults to the production 120 s", async () => {
    expect(DEFAULT_HTTP_IDLE_TIMEOUT_MS).toBe(120_000);
    const host = await PiHost.create({
      agentDir: join(tmpRoot, "agent"),
      ownsProcess: true,
      httpIdleTimeoutMs: 300,
    });
    try {
      expect(host.dispatcher).toBe("installed");
      expect(await fetchFailure(`${base}/?ms=1800`)).toBe("UND_ERR_HEADERS_TIMEOUT");
    } finally {
      host.dispose();
    }
    const dflt = await PiHost.create({ agentDir: join(tmpRoot, "agent2") });
    expect(dflt.httpIdleTimeoutMs).toBe(120_000);
    expect(dflt.dispatcher).toBe("installed");
  });
});
