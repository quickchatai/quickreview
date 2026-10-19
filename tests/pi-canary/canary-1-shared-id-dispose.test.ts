// Canary 1 [P2.7]: a dispose cuts every session that shares its id.
//
// AgentSession.dispose() ends in pi-ai's cleanupSessionResources(sessionId),
// which tells every registered transport to drop what it holds under that id.
// pi-ai's codex websocket cache is one such transport, keyed by session id. Two
// live sessions under ONE id therefore share a socket cache, and disposing the
// first cuts the second's websocket mid-run. That is why lens sessions get
// unique ids (the cache-group design keeps a shared prompt-cache key out of the
// session id), and why this is recorded as a hazard instead of fixed around.
//
// If pi ever scopes cleanup per session object, the KNOWN HAZARD test flips:
// that is the signal to revisit the unique-id rule, not to delete the canary.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { FakeTransport, type Rig, createRig, useOfflineGuard } from "./harness.js";

useOfflineGuard();

let rig: Rig;
let transport: FakeTransport;

beforeEach(async () => {
  rig = await createRig();
  transport = new FakeTransport();
  transport.attach();
});

afterEach(() => {
  transport.detach();
  rig.close();
});

/** One faux turn that opens a socket under the request's session id. */
async function turn(session: Awaited<ReturnType<Rig["open"]>>): Promise<void> {
  rig.faux.appendResponses([
    (_ctx, options) => {
      transport.open(options?.sessionId);
      return fauxAssistantMessage("ok");
    },
  ]);
  await session.prompt("go");
}

describe("[canary 1] session-resource cleanup is keyed by session id", () => {
  it("KNOWN HAZARD: disposing one session cuts a sibling that shares its id", async () => {
    const a = await rig.open({
      sessionManager: SessionManager.inMemory(rig.dir, { id: "shared-id" }),
    });
    const b = await rig.open({
      sessionManager: SessionManager.inMemory(rig.dir, { id: "shared-id" }),
    });
    expect(a.sessionId).toBe("shared-id");
    expect(b.sessionId).toBe("shared-id");
    await turn(a);
    await turn(b);
    expect(transport.isOpen("shared-id")).toBe(true);

    a.dispose();

    expect(transport.cleanups).toEqual(["shared-id"]);
    // b was never disposed, yet its transport is gone.
    expect(transport.isOpen("shared-id")).toBe(false);
  });

  it("unique ids contain the dispose: the sibling's transport survives", async () => {
    const a = await rig.open({
      sessionManager: SessionManager.inMemory(rig.dir, { id: "lens-a" }),
    });
    const b = await rig.open({
      sessionManager: SessionManager.inMemory(rig.dir, { id: "lens-b" }),
    });
    await turn(a);
    await turn(b);

    a.dispose();

    expect(transport.cleanups).toEqual(["lens-a"]);
    expect(transport.isOpen("lens-a")).toBe(false);
    expect(transport.isOpen("lens-b")).toBe(true);

    b.dispose();
    expect(transport.cleanups).toEqual(["lens-a", "lens-b"]);
    expect(transport.isOpen("lens-b")).toBe(false);
  });

  it("the provider is the faux one and answered exactly the scripted turns", async () => {
    const a = await rig.open();
    await turn(a);
    expect(rig.model.provider).toBe("faux");
    expect(rig.faux.state.callCount).toBe(1);
  });
});
