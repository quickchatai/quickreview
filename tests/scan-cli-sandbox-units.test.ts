// `qcr scan units …` inside the scan sandbox (src/scancli.ts cmdScan): the
// host wrapper runs every scan subcommand with QCR_IN_SCAN_SANDBOX set, so the
// sandbox assembly must still carry the unit-cut engine.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cmdScan } from "../src/scancli.js";

let dir: string;
const saved: Record<string, string | undefined> = {};
const KEYS = [
  "QCR_IN_SCAN_SANDBOX",
  "QCR_REVIEWED_REPO",
  "XDG_STATE_HOME",
  "XDG_CONFIG_HOME",
  "QCR_INSTALL",
  "QCR_STATE_HOME",
  "QCR_CONFIG_HOME",
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-sbx-units-"));
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.QCR_IN_SCAN_SANDBOX = "1";
  process.env.QCR_REVIEWED_REPO = join(dir, "repo");
  process.env.XDG_STATE_HOME = join(dir, "state");
  process.env.XDG_CONFIG_HOME = join(dir, "config");
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe("qcr scan units in the sandbox", () => {
  it("is served by the setup engine, not refused for lack of one", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((l: unknown) => void lines.push(String(l)));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await cmdScan(["units", "show"], false);
    expect(lines.join("\n")).not.toMatch(/no setup engine in this assembly/);
  });
});
