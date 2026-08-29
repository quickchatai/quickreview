// the TUI owning the memory forward.
//
// The behaviour that actually matters here is the ADOPT/OWN split: a forward
// somebody else is running (the systemd unit, another qcr tui) must be used
// and left alone, and only a forward this process bound may be closed. Get
// that wrong in the generous direction and every `qcr tui` quit takes memory
// away from a companion container it never started; get it wrong in the
// stingy direction and two TUIs fight over port 1933.
import { describe, expect, it, vi } from "vitest";
import { MemoryForward, studioUrl, type ForwardModule, type ForwarderHandle } from "../src/tui/memforward.js";

const BASE = "http://127.0.0.1:1933";

/** A `createForwarder` stand-in that records what happened to it. */
function fakeModule(opts: { bound?: number; throwOnCreate?: boolean } = {}): {
  mod: ForwardModule;
  closed: () => number;
  created: () => number;
  cfgSeen: () => unknown;
} {
  let closed = 0;
  let created = 0;
  let cfgSeen: unknown;
  const handle: ForwarderHandle = {
    listen: () => Promise.resolve(opts.bound ?? 2),
    close: () => {
      closed += 1;
    },
  };
  const mod: ForwardModule = {
    parseArgs: (argv, env) => ({ cfg: { binds: ["198.51.100.1", "127.0.0.1"], port: 1933, sshHost: "VM", container: "quickreview-sandbox", argv, env } }),
    createForwarder: (cfg) => {
      created += 1;
      cfgSeen = cfg;
      if (opts.throwOnCreate) throw new Error("spawn refused");
      return handle;
    },
  };
  return { mod, closed: () => closed, created: () => created, cfgSeen: () => cfgSeen };
}

const build = (probeAnswers: boolean[], f = fakeModule()): { fwd: MemoryForward; f: typeof f; probes: () => number } => {
  let i = 0;
  let probes = 0;
  const fwd = new MemoryForward({
    baseUrl: BASE,
    repoRoot: "/does/not/matter",
    probe: () => {
      probes += 1;
      return Promise.resolve(probeAnswers[Math.min(i++, probeAnswers.length - 1)] ?? false);
    },
    load: () => Promise.resolve(f.mod),
  });
  return { fwd, f, probes: () => probes };
};

describe("MemoryForward", () => {
  it("adopts a forward that is already listening and never binds one", async () => {
    const { fwd, f } = build([true]);
    const st = await fwd.ensure();
    expect(st.state).toBe("adopted");
    expect(fwd.up).toBe(true);
    expect(f.created()).toBe(0);
  });

  it("leaves an adopted forward running on stop — it is not ours to kill", async () => {
    const { fwd, f } = build([true]);
    await fwd.ensure();
    fwd.stop();
    expect(f.closed()).toBe(0);
  });

  it("starts one when nothing answers, and closes exactly that one on stop", async () => {
    const { fwd, f } = build([false]);
    const st = await fwd.ensure();
    expect(st.state).toBe("owned");
    expect(f.created()).toBe(1);
    fwd.stop();
    expect(f.closed()).toBe(1);
  });

  it("stop is idempotent — a second call cannot double-close", async () => {
    const { fwd, f } = build([false]);
    await fwd.ensure();
    fwd.stop();
    fwd.stop();
    expect(f.closed()).toBe(1);
  });

  it("reports failure, not a crash, when every bind fails and nothing answers", async () => {
    // probe: false (nothing there) -> bind fails -> re-probe: still false.
    const { fwd, f } = build([false, false], fakeModule({ bound: 0 }));
    const st = await fwd.ensure();
    expect(st.state).toBe("failed");
    expect(st.detail).toMatch(/could not bind/);
    expect(fwd.up).toBe(false);
    // The handle is released even though it never served: leaking half-bound
    // servers across a retry is worse than a no-op close.
    expect(f.closed()).toBe(1);
  });

  it("adopts instead of failing when the port was claimed between probe and bind", async () => {
    // The hot-reload handover is exactly this window: our probe saw nothing,
    // the outgoing TUI's replacement bound first, our bind lost. Re-probing
    // heals it; without that, memory stays dead until someone presses `r`.
    const { fwd, f } = build([false, true], fakeModule({ bound: 0 }));
    const st = await fwd.ensure();
    expect(st.state).toBe("adopted");
    expect(fwd.up).toBe(true);
    // Adopted means not ours: stop() must leave the winner running.
    fwd.stop();
    expect(f.closed()).toBe(1); // only the half-bound handle we already released
  });

  it("reports failure when the forwarder throws instead of listening", async () => {
    const { fwd } = build([false], fakeModule({ throwOnCreate: true }));
    const st = await fwd.ensure();
    expect(st.state).toBe("failed");
    expect(st.detail).toMatch(/spawn refused/);
  });

  it("reports failure when the script cannot be loaded at all", async () => {
    const fwd = new MemoryForward({
      baseUrl: BASE,
      repoRoot: "/nope",
      probe: () => Promise.resolve(false),
      load: () => Promise.reject(new Error("ENOENT")),
    });
    const st = await fwd.ensure();
    expect(st.state).toBe("failed");
    expect(st.detail).toMatch(/cannot load the forward script/);
  });

  it("does not bind twice when the boot call and a tab refresh race", async () => {
    // Both callers start with an async probe. Serialised, the second sees the
    // handle the first created; unserialised it would probe an unbound port
    // and start a second forwarder.
    const { fwd, f } = build([false, true]);
    const [a, b] = await Promise.all([fwd.ensure(), fwd.ensure()]);
    expect(f.created()).toBe(1);
    expect(a.state).toBe("owned");
    expect(b.state).toBe("owned");
  });

  it("re-probing an owned forward that died reports failure rather than lying", async () => {
    const { fwd } = build([false, false]);
    expect((await fwd.ensure()).state).toBe("owned");
    // Second ensure() re-probes the forward we own; it does not answer.
    const again = await fwd.ensure();
    expect(again.state).toBe("failed");
    expect(again.detail).toMatch(/stopped answering/);
  });

  it("says so when only some binds came up — the TUI still works", async () => {
    const { fwd } = build([false], fakeModule({ bound: 1 }));
    const st = await fwd.ensure();
    expect(st.state).toBe("owned");
    expect(st.detail).toMatch(/bound 1\/2/);
  });

  it("carries the studio URL in every status, so the tab never builds one", async () => {
    const { fwd } = build([true]);
    const st = await fwd.ensure();
    expect(st.studioUrl).toBe("http://127.0.0.1:1933/studio");
    expect(st.baseUrl).toBe(BASE);
  });

  it("builds the studio URL without doubling a slash", () => {
    expect(studioUrl("http://127.0.0.1:1933/")).toBe("http://127.0.0.1:1933/studio");
    expect(studioUrl("http://127.0.0.1:1933")).toBe("http://127.0.0.1:1933/studio");
  });

  it("hands the real script's own parseArgs the config — no second config source", async () => {
    const { fwd, f } = build([false]);
    await fwd.ensure();
    expect(f.cfgSeen()).toMatchObject({ port: 1933, sshHost: "VM" });
  });
});

describe("the real forward script satisfies the ForwardModule contract", () => {
  // The TUI imports this script dynamically and untyped (it is dependency-free
  // ESM outside tsconfig's include). Nothing else would notice a rename of
  // `createForwarder`/`parseArgs` until a live TUI failed to start a forward.
  it("exports parseArgs and createForwarder with the shapes memforward.ts assumes", async () => {
    const mod = (await import("../scripts/companion-memory-forward.mjs")) as unknown as ForwardModule;
    expect(typeof mod.parseArgs).toBe("function");
    expect(typeof mod.createForwarder).toBe("function");
    const { cfg } = mod.parseArgs(["run"], { QCR_MEMORY_PORT: "1933" } as NodeJS.ProcessEnv);
    expect(cfg.port).toBe(1933);
    expect(Array.isArray(cfg.binds)).toBe(true);
    expect(cfg.binds).toContain("127.0.0.1");
    // Built with a relay spawner that is never invoked: no listen() call here,
    // so no socket is bound and no ssh is spawned by this test.
    const handle = mod.createForwarder(cfg, { log: vi.fn() });
    expect(typeof handle.listen).toBe("function");
    expect(typeof handle.close).toBe("function");
    handle.close();
  });
});

describe("the companion's namespace is materialized before the container starts", () => {
  // Ordering is the whole fix. The companion's pi extension resolves which
  // user namespace to write into ONCE and caches it; a namespace whose
  // directory appears afterwards is not picked up until the process restarts.
  // So `ensureNamespaces()` must run before `companion.ensureUp`, and it needs
  // the forward, so the eager `void memForward.ensure()` at boot is not enough
  // to lean on — it has to be awaited here.
  it("awaits the forward, then ensureNamespaces, then ensureUp", async () => {
    const { readFileSync } = await import("node:fs");
    const index = readFileSync("src/tui/index.ts", "utf8");
    const start = index.indexOf("const startCompanion");
    expect(start, "startCompanion must exist").toBeGreaterThan(-1);
    const body = index.slice(start, start + 2500);
    const fwd = body.indexOf("await memForward.ensure()");
    const ensure = body.indexOf("ensureNamespaces()");
    const up = body.indexOf("companion.ensureUp");
    expect(fwd, "must await the forward inside startCompanion").toBeGreaterThan(-1);
    expect(ensure, "must materialize the namespaces").toBeGreaterThan(-1);
    expect(up, "must start the container").toBeGreaterThan(-1);
    expect(fwd).toBeLessThan(ensure);
    expect(ensure).toBeLessThan(up);
  });
});

describe("the hot-reload handover releases the port before spawning the new build", () => {
  // `realReexec` runs its teardown and then spawnSync's the new TUI in the
  // SAME synchronous frame. `app.quit()` only resolves a promise, so the
  // cleanup after `await running` is a microtask that cannot run until
  // spawnSync returns — i.e. not until the child exits. If the forward is
  // stopped only there, the outgoing process sits inside spawnSync holding
  // :1933 with a frozen event loop and the incoming TUI can never bind.
  it("stops the forward inside the reexec teardown, not only in the quit path", async () => {
    const { readFileSync } = await import("node:fs");
    const index = readFileSync("src/tui/index.ts", "utf8");
    const teardown = /realReexec\(file, \(\) => \{([\s\S]*?)\}\)/.exec(index)?.[1] ?? "";
    expect(teardown, "reexec teardown must exist as a block").not.toBe("");
    expect(teardown).toContain("memForward.stop()");
    expect(teardown).toContain("app.quit()");
    // Order matters: release the port, then let the run loop finish.
    expect(teardown.indexOf("memForward.stop()")).toBeLessThan(teardown.indexOf("app.quit()"));
  });
});
