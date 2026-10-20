import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waitForSessionBridgeReady, writeSessionBridgeState } from "../src/overseer-bridge.js";

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-overseer-bridge-"));
  path = join(dir, "pr-42.bridge.json");
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("generation-fenced session bridge readiness", () => {
  it("accepts readiness only from the requested process generation", async () => {
    writeSessionBridgeState(path, {
      version: 1,
      session: "pr-42",
      generation: "current",
      stage: "ready",
      updated_at: "2026-09-01T10:00:00.000Z",
    });

    await expect(waitForSessionBridgeReady(path, "pr-42", "current", 20, 1)).resolves.toMatchObject(
      {
        generation: "current",
        stage: "ready",
      },
    );
  });

  it("ignores a stale generation until the bounded wait expires", async () => {
    writeSessionBridgeState(path, {
      version: 1,
      session: "pr-42",
      generation: "stale",
      stage: "ready",
      updated_at: "2026-09-01T09:59:00.000Z",
    });

    await expect(waitForSessionBridgeReady(path, "pr-42", "current", 5, 1)).rejects.toThrow(
      /timed out.*generation current/,
    );
  });

  it("surfaces the bridge's durable pre-reserve failure stage", async () => {
    writeSessionBridgeState(path, {
      version: 1,
      session: "pr-42",
      generation: "current",
      stage: "failed",
      updated_at: "2026-09-01T10:00:00.000Z",
      failed_stage: "ledger_open",
      detail: "database unavailable",
    });

    await expect(waitForSessionBridgeReady(path, "pr-42", "current", 20, 1)).rejects.toThrow(
      /failed at ledger_open: database unavailable/,
    );
  });
});
