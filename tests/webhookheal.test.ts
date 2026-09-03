// the webhook-URL self-heal — hostname-file watcher + gated re-point.
// All I/O faked except the temp-dir hostname file itself (the thing under
// test); the GitHub reads/writes are recorded fakes, never a network.
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type FSWatcher,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebhookHealer, type WebhookHealDeps } from "../src/webhookheal.js";
import type { GateResult } from "../src/gate.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-heal-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

interface Fake {
  healer: WebhookHealer;
  file: string;
  events: Array<{ kind: string; payload: unknown }>;
  anomalies: string[];
  logs: string[];
  remote: { url: string };
  patches: Array<{ newUrl: string; oldUrl: string }>;
  readConfig: Mock<() => Promise<{ url: string }>>;
  updateUrl: ReturnType<typeof vi.fn>;
}

function build(
  overrides: Partial<WebhookHealDeps> = {},
  remoteUrl = "https://old.example.com/webhook",
): Fake {
  const file = join(dir, "hostname");
  const events: Fake["events"] = [];
  const anomalies: string[] = [];
  const logs: string[] = [];
  const remote = { url: remoteUrl };
  const patches: Fake["patches"] = [];
  const readConfig = vi.fn(async () => ({ url: remote.url }));
  const updateUrl = vi.fn(async (newUrl: string, oldUrl: string): Promise<GateResult> => {
    patches.push({ newUrl, oldUrl });
    remote.url = newUrl; // GitHub applies the PATCH; read-back then sees it
    return { executed: true, response: {} };
  });
  const healer = new WebhookHealer({
    hostnameFile: file,
    readConfig,
    updateUrl,
    logEvent: (kind, payload) => events.push({ kind, payload }),
    anomaly: (detail) => anomalies.push(detail),
    log: (msg) => logs.push(msg),
    sweepIntervalMs: 0,
    parseRetries: 1,
    retryDelayMs: 5,
    ...overrides,
  });
  return { healer, file, events, anomalies, logs, remote, patches, readConfig, updateUrl };
}

describe("the heal pass (sweep)", () => {
  it("re-points when the hostname differs from the App config, and read-back verifies", async () => {
    const f = build();
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("healed");
    expect(f.patches).toEqual([
      {
        newUrl: "https://abc.trycloudflare.com/webhook",
        oldUrl: "https://old.example.com/webhook",
      },
    ]);
    // The loud record names old and new.
    const event = f.events.find((e) => e.kind === "webhook_url_repointed");
    expect(event?.payload).toEqual({
      old_url: "https://old.example.com/webhook",
      new_url: "https://abc.trycloudflare.com/webhook",
    });
    expect(f.anomalies).toEqual([]);
  });

  it("tolerates trailing whitespace/newline and normalizes case", async () => {
    const f = build();
    writeFileSync(f.file, "  ABC.TryCloudflare.Com \n\n");
    expect(await f.healer.sweep()).toBe("healed");
    expect(f.patches[0]!.newUrl).toBe("https://abc.trycloudflare.com/webhook");
  });

  it("no-ops when the config already matches — no PATCH, no event", async () => {
    const f = build({}, "https://abc.trycloudflare.com/webhook");
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("noop");
    expect(f.updateUrl).not.toHaveBeenCalled();
    expect(f.events).toEqual([]);
  });

  it("uses a custom webhook path when configured", async () => {
    const f = build({ webhookPath: "/hooks/github" });
    writeFileSync(f.file, "abc.trycloudflare.com");
    await f.healer.sweep();
    expect(f.patches[0]!.newUrl).toBe("https://abc.trycloudflare.com/hooks/github");
  });
});

describe("hostname-file faults", () => {
  it("a missing file is a no-op, logged ONCE across sweeps", async () => {
    const f = build();
    expect(await f.healer.sweep()).toBe("missing");
    expect(await f.healer.sweep()).toBe("missing");
    expect(f.logs.filter((l) => l.includes("absent"))).toHaveLength(1);
    expect(f.updateUrl).not.toHaveBeenCalled();
    expect(f.anomalies).toEqual([]);
  });

  it("a file that disappears and returns logs the absence again", async () => {
    const f = build();
    await f.healer.sweep();
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("healed");
    unlinkSync(f.file);
    expect(await f.healer.sweep()).toBe("missing");
    expect(f.logs.filter((l) => l.includes("absent"))).toHaveLength(2);
  });

  it("retries a partial write into shape before judging it (verdicts.ts pattern)", async () => {
    const f = build({ parseRetries: 6, retryDelayMs: 15 });
    writeFileSync(f.file, ""); // the sidecar opened the file, bytes not landed
    setTimeout(() => writeFileSync(f.file, "abc.trycloudflare.com\n"), 30);
    expect(await f.healer.sweep()).toBe("healed");
    expect(f.anomalies).toEqual([]);
  });

  it("content that never settles into a hostname raises ONE anomaly per distinct content", async () => {
    const f = build();
    writeFileSync(f.file, "https://not-a-bare-hostname/with/path\n");
    expect(await f.healer.sweep()).toBe("invalid");
    expect(await f.healer.sweep()).toBe("invalid");
    expect(f.anomalies).toHaveLength(1);
    expect(f.anomalies[0]).toContain("never parsed as a bare hostname");
    expect(f.events.filter((e) => e.kind === "webhook_heal_invalid_hostname")).toHaveLength(1);
    // A NEW piece of garbage is loud again; a good write then heals.
    writeFileSync(f.file, "still bad content");
    expect(await f.healer.sweep()).toBe("invalid");
    expect(f.anomalies).toHaveLength(2);
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("healed");
  });
});

describe("GitHub-side faults — loud, never a crash", () => {
  it("a failing config read is an anomaly + event, not a throw", async () => {
    const f = build();
    f.readConfig.mockRejectedValue(new Error("401 bad JWT"));
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("failed");
    expect(f.anomalies[0]).toContain("GET /app/hook/config failed");
    expect(f.events.some((e) => e.kind === "webhook_heal_read_failed")).toBe(true);
    expect(f.updateUrl).not.toHaveBeenCalled();
  });

  it("a failing PATCH is an anomaly + event, not a throw", async () => {
    const f = build();
    f.updateUrl.mockRejectedValue(new Error("422 unprocessable"));
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("failed");
    expect(f.anomalies[0]).toContain("PATCH /app/hook/config");
    expect(f.events.some((e) => e.kind === "webhook_heal_patch_failed")).toBe(true);
  });

  it("a re-point that does not stick on read-back is an anomaly naming both URLs", async () => {
    const f = build();
    f.updateUrl.mockResolvedValue({ executed: true, response: {} }); // remote.url never moves
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("failed");
    expect(f.anomalies[0]).toContain("did not stick");
    expect(f.anomalies[0]).toContain("https://abc.trycloudflare.com/webhook");
    expect(f.anomalies[0]).toContain("https://old.example.com/webhook");
    expect(f.events.some((e) => e.kind === "webhook_heal_verify_failed")).toBe(true);
  });
});

describe("the watcher (fast path) and its fallbacks", () => {
  it("start() sweeps immediately, then heals a later rotation via fs.watch + debounce", async () => {
    const f = build({ debounceMs: 20 });
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    f.healer.start();
    await vi.waitFor(() => expect(f.remote.url).toBe("https://abc.trycloudflare.com/webhook"), {
      timeout: 2000,
    });
    // The quick tunnel restarts and gets a new hostname.
    writeFileSync(f.file, "rotated.trycloudflare.com\n");
    await vi.waitFor(() => expect(f.remote.url).toBe("https://rotated.trycloudflare.com/webhook"), {
      timeout: 2000,
    });
    f.healer.stop();
  });

  it("start() creates the hostname dir so the watch has something to attach to", () => {
    const nested = join(dir, "state", "ingress", "hostname");
    const f = build({ hostnameFile: nested });
    f.healer.start();
    f.healer.stop();
    // No throw, and the missing FILE was handled as the ordinary missing case.
    expect(f.logs.some((l) => l.includes("absent"))).toBe(true);
  });

  it("an un-watchable location degrades to the polling sweep instead of crashing", async () => {
    const asFile = join(dir, "not-a-dir");
    writeFileSync(asFile, "plain file where a dir is needed");
    const f = build({ hostnameFile: join(asFile, "hostname") });
    f.healer.start(); // mkdir/watch fail — caught, logged
    expect(f.logs.some((l) => l.includes("polling sweep continues alone"))).toBe(true);
    // The reliable path still runs (let the startup sweep settle first — its
    // promise chain is still resolving when start() returns).
    await new Promise((r) => setTimeout(r, 0));
    expect(f.logs.some((l) => l.includes("absent"))).toBe(true);
    expect(await f.healer.sweep()).toBe("missing");
    f.healer.stop();
  });

  it("a watcher that errors at RUNTIME degrades to the polling sweep, never a crash", async () => {
    const f = build();
    f.healer.start();
    const inner = f.healer as unknown as { watcher: FSWatcher | null };
    expect(inner.watcher).toBeTruthy();
    inner.watcher!.emit("error", new Error("EMFILE: too many open files"));
    expect(f.logs.some((l) => l.includes("fs.watch failed"))).toBe(true);
    expect(inner.watcher).toBeNull();
    // The reliable path is untouched: a rotation still heals through a sweep.
    // Let start()'s own sweep settle first — while it is in flight a second
    // sweep is QUEUED (returns "noop"), which is the healer working, not
    // failing.
    await new Promise((r) => setTimeout(r, 0));
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    expect(await f.healer.sweep()).toBe("healed");
    f.healer.stop();
  });

  it("the periodic sweep is the RELIABLE path — it heals even when fs.watch never fires", async () => {
    // Debounce set far beyond the test's patience, so only the interval can be
    // responsible for the re-point: this is the polling backstop, alone.
    const f = build({ sweepIntervalMs: 25, debounceMs: 60_000 });
    f.healer.start();
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    await vi.waitFor(() => expect(f.remote.url).toBe("https://abc.trycloudflare.com/webhook"), {
      timeout: 2000,
    });
    f.healer.stop();
  });

  it("concurrent sweeps never overlap — the second is queued, not run", async () => {
    const f = build();
    let inflight = 0;
    let maxInflight = 0;
    f.readConfig.mockImplementation(async () => {
      inflight++;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return { url: f.remote.url };
    });
    writeFileSync(f.file, "abc.trycloudflare.com\n");
    const [a, b] = await Promise.all([f.healer.sweep(), f.healer.sweep()]);
    expect(maxInflight).toBe(1);
    expect([a, b].sort()).toEqual(["healed", "noop"]);
  });
});

describe("wiring: a daemon without the tunnel shape never starts a watcher", () => {
  const wire = readFileSync(join(process.cwd(), "src", "wire.ts"), "utf8");
  const example = readFileSync(join(process.cwd(), "config.example.toml"), "utf8");

  it("the healer is constructed ONLY inside the tunnel-file branch", () => {
    // Source-text tripwire (the wire-memory.test.ts pattern): the production
    // assembly is not otherwise reachable from a unit test, and "off unless
    // configured" is an acceptance criterion, not an implementation detail.
    expect(wire.match(/new WebhookHealer\(/g) ?? []).toHaveLength(1);
    const guarded = wire.slice(wire.indexOf(`cfg.ingress.shape === "tunnel-file"`));
    expect(guarded.indexOf("new WebhookHealer(")).toBeGreaterThan(-1);
    expect(wire.indexOf("new WebhookHealer(")).toBeGreaterThan(
      wire.indexOf(`cfg.ingress.shape === "tunnel-file"`),
    );
  });

  it("it is handed the resolved hostname file, the ledger and the anomaly surface", () => {
    expect(wire).toContain("hostnameFile: ingressHostnameFile(cfg, root)");
    expect(wire).toMatch(/logEvent:\s*\(kind, payload\)/);
    expect(wire).toMatch(/anomaly:\s*\(detail\)/);
    expect(wire).toMatch(/debounceMs:\s*cfg\.ingress\.debounce_ms/);
    expect(wire).toMatch(/sweepIntervalMs:\s*cfg\.ingress\.sweep_interval_s \* 1000/);
  });

  it("the gate's loud app-self-config line goes to the daemon log", () => {
    expect(wire).toContain("gate.setLog(log)");
  });

  it("shutdown stops the watcher", () => {
    expect(wire).toContain("webhookHeal?.stop()");
  });

  it("config.example.toml documents the block — commented out, so the default stays off", () => {
    expect(example).toContain("#[ingress]");
    for (const knob of ["shape", "hostname_file", "debounce_ms", "sweep_interval_s"]) {
      expect(example).toMatch(new RegExp(`^#${knob} = `, "m"));
    }
    expect(example).toContain("tunnel-file");
  });
});
