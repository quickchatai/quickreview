// Canary 15: the offline refresh at host creation.
//
// VERIFY-ON-PIN: PiHost.create runs `runtime.refresh({ allowNetwork: false })`
// right after it swaps pi's auth context for the isolated one. Every SDK host
// leans on four things about that call, and each is held here against the
// real pi:
//
//   1. it makes no request, even where pi's own offline switch is not set
//      (a `qcr review` process does not set PI_OFFLINE);
//   2. it restores the catalog overlay pi stored in the agent dir
//      (`models-store.json`: the models pi learned since its build), so the
//      host knows the models the person's own pi knows;
//   3. it fills the availability snapshot the registry facade reads, so the
//      route's inventory needs nothing else from pi;
//   4. the isolated auth context is still the one in place afterwards: the
//      environment the host named is what a credential is looked up in, and
//      a `~` path is absent.
//
// If pi stops restoring the overlay offline, or starts reaching out, the
// fallback is to hand a host the pi model object an earlier step resolved
// (PiHostOptions.route `fixed`) and to say that the CLI and a running pi may
// name different models.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiHost } from "@quickchatai/pi-quickreview/src/engine/pisdk.js";
import { installOfflineGuard, useOfflineGuard } from "./harness.js";

useOfflineGuard();

/** A built-in provider that takes a plain API key from one environment variable. */
const PROVIDER = "deepseek";
const KEY_ENV = "DEEPSEEK_API_KEY";
/** A model pi's built-in catalog does not hold: it can only come from the overlay. */
const OVERLAY_ID = "qcr-canary-overlay-model";

let dir: string;
let agentDir: string;
let savedOffline: string | undefined;
const hosts: PiHost[] = [];

/** The overlay as pi stores it: one provider's entry, newer than pi's build. */
function writeOverlay(): void {
  const base = getBuiltinModels(PROVIDER)[0]!;
  writeFileSync(
    join(agentDir, "models-store.json"),
    JSON.stringify({
      [PROVIDER]: {
        models: [{ ...base, id: OVERLAY_ID, name: "Overlay Only" }],
        // Far in the future: pi restores an overlay only when it is newer than
        // the model data it was built with.
        lastModified: Date.UTC(2999, 0, 1),
        checkedAt: Date.now(),
      },
    }),
  );
}

async function host(options: Partial<Parameters<typeof PiHost.create>[0]> = {}): Promise<PiHost> {
  const h = await PiHost.create({ agentDir, authEnv: {}, ...options });
  hosts.push(h);
  return h;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pi-canary-refresh-"));
  agentDir = join(dir, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeOverlay();
  // The harness sets pi's offline switch for every canary. This one takes it
  // away: the refresh must stay offline on its own argument.
  savedOffline = process.env["PI_OFFLINE"];
  delete process.env["PI_OFFLINE"];
});

afterEach(() => {
  for (const h of hosts.splice(0)) h.dispose();
  if (savedOffline !== undefined) process.env["PI_OFFLINE"] = savedOffline;
  rmSync(dir, { recursive: true, force: true });
});

describe("[canary 15] the offline refresh at host creation", () => {
  it("the control: without a refresh, pi does not know the overlay model", async () => {
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
      modelsStorePath: join(agentDir, "models-store.json"),
      refreshOnCreate: false,
    });
    expect(runtime.getModel(PROVIDER, OVERLAY_ID)).toBeUndefined();
  });

  // MUTATION: delete `await runtime.refresh({ allowNetwork: false })` from
  // PiHost.create — the overlay model is unknown and this fails.
  it("restores the stored overlay model and makes no request, with PI_OFFLINE unset", async () => {
    expect(process.env["PI_OFFLINE"]).toBeUndefined();
    const guard = installOfflineGuard();
    let attempts: string[];
    let h: PiHost;
    try {
      h = await host();
      // A refresh pi left running would reach out after create returned.
      await new Promise((r) => setTimeout(r, 100));
    } finally {
      attempts = guard.restore().attempts;
    }
    expect(attempts).toEqual([]);
    const overlay = h.modelRuntime.getModel(PROVIDER, OVERLAY_ID);
    expect(overlay).toMatchObject({ provider: PROVIDER, id: OVERLAY_ID });
    // The built-in catalog is still there beside it.
    expect(h.modelRuntime.getModel(PROVIDER, getBuiltinModels(PROVIDER)[0]!.id)).toBeDefined();
  });

  it("fills the snapshot the registry facade reads, with nothing awaited after create", async () => {
    const h = await host({ authEnv: { [KEY_ENV]: "not-a-key" } });
    const registry = new ModelRegistry(h.modelRuntime);
    expect(registry.getAll().some((m) => m.provider === PROVIDER && m.id === OVERLAY_ID)).toBe(
      true,
    );
    expect(registry.getProviderAuthStatus(PROVIDER)).toEqual({
      configured: true,
      source: "environment",
      label: KEY_ENV,
    });
    const available = registry.getAvailable().filter((m) => m.provider === PROVIDER);
    expect(available.map((m) => m.id)).toContain(OVERLAY_ID);
  });

  // MUTATION: drop the isolateProviderAuth call from PiHost.create — pi's own
  // context reads the process's key and the first expectation fails.
  it("leaves the isolated auth context in place: the named environment, and no `~`", async () => {
    // The process holds a key the host was not handed; the host's own
    // environment holds none.
    process.env[KEY_ENV] = "not-a-key";
    try {
      const bare = await host({ authEnv: {} });
      expect(new ModelRegistry(bare.modelRuntime).getProviderAuthStatus(PROVIDER)).toEqual({
        configured: false,
      });
    } finally {
      delete process.env[KEY_ENV];
    }
    const keyed = await host({ authEnv: { [KEY_ENV]: "not-a-key" } });
    expect(new ModelRegistry(keyed.modelRuntime).getProviderAuthStatus(PROVIDER).configured).toBe(
      true,
    );
    // pi's own context expands `~` to the home, which exists; the isolated one
    // answers without looking.
    const context = (
      keyed.modelRuntime as unknown as {
        models: { authContext: { fileExists(path: string): Promise<boolean> } };
      }
    ).models.authContext;
    expect(await context.fileExists("~")).toBe(false);
  });

  it("the host's route reads the overlay model as any other", async () => {
    const h = await host({
      authEnv: { [KEY_ENV]: "not-a-key" },
      route: { pin: { text: `${PROVIDER}/${OVERLAY_ID}`, from: "flag" } },
    });
    const result = await h.route();
    expect(result).toMatchObject({
      ok: true,
      route: { provider: PROVIDER, modelId: OVERLAY_ID, custom: false, pick: "pinned" },
    });
  });
});
