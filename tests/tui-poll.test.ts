import { describe, expect, it } from "vitest";
import { TUI_DEFAULTS } from "../src/config.js";
import type { StatusSnapshot } from "../src/state.js";
import { Poller, classifyHealth, parseSnapshot } from "../src/tui/poll.js";
import type { RemoteResult, SshRunner } from "../src/tui/remote.js";

const snap = (writtenAt: string, heartbeat = writtenAt): StatusSnapshot => ({
  written_at: writtenAt,
  dry_run: true,
  prs: [],
  running_rounds: 0,
  total_spend_usd: 0,
  heartbeat,
});

describe("classifyHealth", () => {
  const now = new Date("2026-08-13T12:00:00Z");

  it("is unreachable before any successful fetch", () => {
    expect(classifyHealth(now, 3, undefined, false, undefined)).toEqual({ kind: "unreachable", sinceS: Number.POSITIVE_INFINITY });
  });

  it("is unreachable when the last fetch failed, reporting time since last success", () => {
    const h = classifyHealth(now, 3, snap("2026-08-13T11:59:00Z"), false, new Date("2026-08-13T11:59:00Z"));
    expect(h).toEqual({ kind: "unreachable", sinceS: 60 });
  });

  it("is stale when written_at ages past the stale_after threshold", () => {
    const h = classifyHealth(now, 45, snap("2026-08-13T11:59:00Z"), true, now);
    expect(h).toEqual({ kind: "stale", dataAgeS: 60 });
  });

  it("tolerates the daemon's ~30s write cadence at the default threshold", () => {
    const h = classifyHealth(now, 90, snap("2026-08-13T11:59:30Z", "2026-08-13T11:59:30Z"), true, now);
    expect(h).toEqual({ kind: "ok", heartbeatAgeS: 30 });
  });

  it("reports a fresh process with failed review work as pipeline-unhealthy", () => {
    const unhealthy = snap("2026-08-13T11:59:58Z", "2026-08-13T11:59:56Z");
    unhealthy.pipeline = {
      healthy: false,
      failed_loud: 1,
      causes: [{ key: "review-failure:cmd-1", pr: 5408, since: "2026-08-13T11:55:00Z", stage: "command_start", detail: "no start", next_action: "operator_unwedge" }],
    };
    expect(classifyHealth(now, 90, unhealthy, true, now)).toEqual({
      kind: "pipeline_unhealthy",
      heartbeatAgeS: 4,
      causes: unhealthy.pipeline.causes,
    });
  });

  it("is ok inside the freshness window and reports heartbeat age", () => {
    const h = classifyHealth(now, 90, snap("2026-08-13T11:59:58Z", "2026-08-13T11:59:56Z"), true, now);
    expect(h).toEqual({ kind: "ok", heartbeatAgeS: 4 });
  });
});

describe("parseSnapshot", () => {
  it("accepts a well-formed snapshot", () => {
    expect(parseSnapshot(JSON.stringify(snap("2026-08-13T12:00:00Z")))).toBeDefined();
  });

  it("rejects garbage and shape mismatches", () => {
    expect(parseSnapshot("not json")).toBeUndefined();
    expect(parseSnapshot("{}")).toBeUndefined();
    expect(parseSnapshot(JSON.stringify({ written_at: "x" }))).toBeUndefined();
  });
});

describe("Poller", () => {
  const ok = (stdout: string): RemoteResult => ({ ok: true, stdout, stderr: "", code: 0 });
  const fail = (): RemoteResult => ({ ok: false, stdout: "", stderr: "ssh: boom", code: 255 });

  it("stores snapshots on success and resets the failure count", async () => {
    let calls = 0;
    const ssh: SshRunner = async () => {
      calls++;
      return ok(JSON.stringify(snap(new Date().toISOString())));
    };
    const p = new Poller(TUI_DEFAULTS, ssh, () => {});
    await p.tick();
    expect(calls).toBe(1);
    expect(p.state.snapshot).toBeDefined();
    expect(p.state.consecutiveFailures).toBe(0);
    expect(p.health().kind).toBe("ok");
    expect(p.nextDelayMs()).toBe(3000);
  });

  it("backs off linearly on failures, capped at 5×", async () => {
    const ssh: SshRunner = async () => fail();
    const p = new Poller(TUI_DEFAULTS, ssh, () => {});
    for (let i = 0; i < 7; i++) await p.tick();
    expect(p.state.consecutiveFailures).toBe(7);
    expect(p.nextDelayMs()).toBe(3000 * 5);
    expect(p.health().kind).toBe("unreachable");
  });

  it("keeps the last snapshot through failures (stale, not blank)", async () => {
    let n = 0;
    const written = "2026-08-13T11:00:00Z";
    const ssh: SshRunner = async () => (n++ === 0 ? ok(JSON.stringify(snap(written))) : fail());
    const p = new Poller(TUI_DEFAULTS, ssh, () => {});
    await p.tick();
    await p.tick();
    expect(p.state.snapshot?.written_at).toBe(written);
    expect(p.health().kind).toBe("unreachable"); // last fetch failed wins over age
  });

  it("notifies on every tick", async () => {
    let updates = 0;
    const ssh: SshRunner = async () => fail();
    const p = new Poller(TUI_DEFAULTS, ssh, () => updates++);
    await p.tick();
    await p.tick();
    expect(updates).toBe(2);
  });
});
