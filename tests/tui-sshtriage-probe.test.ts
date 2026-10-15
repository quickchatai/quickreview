// The real probe runner, against a real (absent) program: no ssh, no network.
// A probe that cannot even start prints nothing of its own, so the runner's
// own error is the only evidence the triage can show the operator.
import { describe, expect, it } from "vitest";
import { classifyConnection, realProbeRunner } from "../src/tui/sshtriage.js";

describe("realProbeRunner", () => {
  it("a program that cannot be run says why in stderr — not an empty failure", async () => {
    const r = await realProbeRunner("/nonexistent/qcr-no-such-probe", ["-G", "VM"], 5_000);
    expect(r.timedOut).toBe(false);
    expect(r.status).toBeNull();
    expect(r.stderr).toMatch(/ENOENT/);
    // …and the triage line carries it as its evidence.
    const d = classifyConnection({
      host: "VM",
      masterAlive: false,
      controlSocketExists: false,
      identityFiles: [],
      agent: { reachable: true, identities: ["256 SHA256:x key (ED25519)"] },
      connect: { ok: false, stderr: r.stderr, timedOut: r.timedOut },
    });
    expect(d.cause).toMatch(/ENOENT/);
  });

  it("a program that runs and fails keeps its own stderr", async () => {
    const r = await realProbeRunner("sh", ["-c", "echo refused >&2; exit 3"], 5_000);
    expect(r).toMatchObject({ status: 3, stderr: "refused\n", timedOut: false });
  });
});
