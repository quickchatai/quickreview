// the status.json `memory` block and the state it is built from:
// the block reaches the heartbeat BESIDE the unauthenticated `openviking`
// block (never instead of it), a throwing read never costs the heartbeat, the
// open incident survives a restart through the events table, and `qcr status`
// prints it. StateStore(":memory:"), temp dirs, fake adapter — no network.
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderStatus } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { createDaemon, type DaemonAdapter } from "../src/daemon.js";
import {
  MemoryHealthMonitor,
  disabledMemoryStatus,
  type MemoryStatus,
} from "../src/memory/health.js";
import { StateStore, buildStatusSnapshot, type StatusSnapshot } from "../src/state.js";
import { stubSessionHooks } from "../src/stubs.js";
import { HEAVY_TIMEOUT_MS } from "./helpers/suite-timeouts.js";

const T0 = Date.parse("2026-10-06T12:00:00.000Z");

async function authFailedBlock(): Promise<MemoryStatus> {
  const m = new MemoryHealthMonitor({
    probes: {
      daemon: async () => ({
        result: "auth_failed",
        status: 401,
        code: "UNAUTHENTICATED",
        ms: 3,
        detail: "Invalid API Key",
      }),
      sessions: async () => ({ result: "ok", status: 200, code: "", ms: 3 }),
    },
    wake: () => {},
    now: () => new Date(T0),
  });
  await m.probeNow();
  return m.status();
}

describe("the status.json memory block", () => {
  it(
    "reaches the heartbeat beside `openviking`, and a throwing read never breaks it",
    { timeout: HEAVY_TIMEOUT_MS },
    async () => {
      const root = mkdtempSync(join(tmpdir(), "qcr-memstatus-"));
      const store = new StateStore(":memory:");
      const block = await authFailedBlock();
      try {
        for (const d of ["state", "state/dryrun", "verdict", "inject"])
          mkdirSync(join(root, d), { recursive: true });
        const adapter = {
          searchLabelTriggered: async () => [],
          searchTeamTriggered: async () => [],
          listOpenPrs: async () => [],
          stalenessScan: async () => [],
          listBotReviewComments: async () => [],
        } as unknown as DaemonAdapter;
        const cfg = loadConfig(join(process.cwd(), "tests/fixtures/config.toml"));
        const daemon = createDaemon({
          cfg,
          root,
          store,
          adapter,
          hooks: stubSessionHooks(root),
          listen: false,
          log: () => {},
          openvikingStatus: () => ({
            enabled: true,
            running: true,
            reachable: true,
            ready: true,
            pinned_version: "0.4.15",
            restarts: 0,
          }),
          memoryStatus: () => block,
        });
        await daemon.start();
        const snap = JSON.parse(
          readFileSync(join(root, "state", "status.json"), "utf8"),
        ) as StatusSnapshot;
        // The unauthenticated probe said "ready" all through the outage —
        // which is exactly why the authenticated block must sit beside it.
        expect(snap.openviking).toMatchObject({ ready: true });
        expect(snap.memory).toMatchObject({
          enabled: true,
          state: "auth_failed",
          credentials: {
            daemon: { result: "auth_failed", status: 401 },
            sessions: { result: "ok" },
          },
        });
        await daemon.stop();

        const store2 = new StateStore(":memory:");
        const angry = createDaemon({
          cfg,
          root,
          store: store2,
          adapter,
          hooks: stubSessionHooks(root),
          listen: false,
          log: () => {},
          memoryStatus: () => {
            throw new Error("health on fire");
          },
        });
        await angry.start();
        const after = JSON.parse(
          readFileSync(join(root, "state", "status.json"), "utf8"),
        ) as StatusSnapshot;
        expect(after.heartbeat).toBeTruthy();
        expect(after.memory).toBeUndefined();
        await angry.stop();
        store2.close();
      } finally {
        store.close();
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("buildStatusSnapshot carries it when given, and omits it when not", async () => {
    const store = new StateStore(":memory:");
    try {
      expect(buildStatusSnapshot(store, false).memory).toBeUndefined();
      const block = await authFailedBlock();
      const snap = buildStatusSnapshot(
        store,
        false,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        block,
      );
      expect(JSON.parse(JSON.stringify(snap)).memory.state).toBe("auth_failed");
    } finally {
      store.close();
    }
  });
});

describe("the persisted memory incident", () => {
  it("round-trips through the events table, and a close clears it", () => {
    const store = new StateStore(":memory:");
    try {
      expect(store.memoryIncident()).toBeNull();
      store.recordMemoryIncident({ kind: "down", since: "2026-10-06T09:00:00.000Z" });
      expect(store.memoryIncident()).toEqual({ kind: "down", since: "2026-10-06T09:00:00.000Z" });
      store.recordMemoryIncident({ kind: "auth_failed", since: "2026-10-06T09:00:00.000Z" });
      expect(store.memoryIncident()?.kind).toBe("auth_failed");
      store.recordMemoryIncident(null);
      expect(store.memoryIncident()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("an unreadable row reads as no incident, never a throw", () => {
    const store = new StateStore(":memory:");
    try {
      store.db
        .prepare(
          "INSERT INTO events (ts, kind, pr, payload) VALUES (?, 'memory_incident', NULL, ?)",
        )
        .run("2026-10-06T00:00:00Z", "{ torn");
      expect(store.memoryIncident()).toBeNull();
      store.logEvent("memory_incident", null, { kind: "weird", since: 3 });
      expect(store.memoryIncident()).toBeNull();
    } finally {
      store.close();
    }
  });

  it("lastEventPayload reads the newest object payload of a kind", () => {
    const store = new StateStore(":memory:");
    try {
      expect(store.lastEventPayload("memory_provision_woken")).toBeNull();
      store.logEvent("memory_provision_woken", null, { at: "A" });
      store.logEvent("memory_provision_woken", null, { at: "B" });
      expect(store.lastEventPayload("memory_provision_woken")).toEqual({ at: "B" });
    } finally {
      store.close();
    }
  });

  it("a monitor built over the store continues a persisted incident", async () => {
    const store = new StateStore(":memory:");
    try {
      store.recordMemoryIncident({ kind: "auth_failed", since: "2026-10-06T09:00:00.000Z" });
      const m = new MemoryHealthMonitor({
        probes: {
          daemon: async () => ({
            result: "auth_failed",
            status: 401,
            code: "UNAUTHENTICATED",
            ms: 1,
          }),
          sessions: async () => ({ result: "ok", status: 200, code: "", ms: 1 }),
        },
        wake: () => {},
        now: () => new Date(T0),
        incidents: {
          load: () => store.memoryIncident(),
          save: (i) => store.recordMemoryIncident(i),
        },
      });
      await m.probeNow();
      expect(m.status().incident).toEqual({
        kind: "auth_failed",
        since: "2026-10-06T09:00:00.000Z",
      });
      expect(store.memoryIncident()?.since).toBe("2026-10-06T09:00:00.000Z");
    } finally {
      store.close();
    }
  });
});

describe("`qcr status` — the memory line", () => {
  const base: StatusSnapshot = {
    written_at: new Date(T0 + 125 * 60_000).toISOString(),
    dry_run: false,
    prs: [],
    running_rounds: 0,
    total_spend_usd: 0,
    heartbeat: new Date(T0).toISOString(),
  };

  it("says AUTH FAILED, for how long, and which credential", async () => {
    const out = renderStatus({ ...base, memory: await authFailedBlock() });
    expect(out).toContain("memory: AUTH FAILED for 2h05m");
    expect(out).toContain("daemon key auth_failed (401 UNAUTHENTICATED: Invalid API Key)");
    expect(out).toContain("sessions' ovcli.conf ok");
  });

  it("never prints healthy for a block that is absent or not monitored", () => {
    expect(renderStatus(base)).toContain("memory: NOT REPORTED");
    expect(
      renderStatus({
        ...base,
        memory: disabledMemoryStatus("no OpenViking server on this machine"),
      }),
    ).toContain("memory: not monitored — no OpenViking server on this machine");
  });
});
