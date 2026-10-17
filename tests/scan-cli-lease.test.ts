// The scan driver lease (src/setup/scanlease.ts) as two ScanRunners over one
// state home see it — the companion and a `qcr scan start` driver, or two
// drivers: the one that drives holds the lease; the other reads its run as
// running (not interrupted), refuses to start a second run, and leaves the
// run's stop request to the holder. A lease no longer renewed lapses, and the
// run reads as interrupted again.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRIVER_FILE, LEASE_TTL_MS } from "../src/setup/scanlease.js";
import { SCAN_STOP_FILE } from "../src/setup/scanreport.js";
import { scanRig } from "./helpers/scan-cli-rig.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-lease-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function startHanging() {
  const clock = { t: Date.parse("2026-09-29T10:00:00Z") };
  const a = scanRig({ dir, hang: (s) => s.unit === "lib", holder: "driver-a", clock });
  const b = scanRig({ dir, holder: "driver-b", clock });
  const p = await a.scan.preview();
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await a.scan.start({ key: p.preview.key });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { a, b, run: r.run };
}

describe("the scan driver lease", () => {
  it("another runner reads the held run as running and refuses a second start", async () => {
    const { a, b, run } = await startHanging();
    expect(b.scan.status().run).toMatchObject({ id: run.id, display: "running" });
    expect(b.scan.status().active).toBe(false);
    const p = await b.scan.preview();
    if (!p.ok) throw new Error("preview");
    const refused = await b.scan.start({ key: p.preview.key });
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.errors.join(" ")).toMatch(
      new RegExp(`scan ${run.id} is running in another process`),
    );
    a.scan.stop();
    await a.scan.idle();
  });

  it("a stop request for the held run is left to its holder, which answers it", async () => {
    const { a, b, run } = await startHanging();
    writeFileSync(
      join(a.home, SCAN_STOP_FILE),
      JSON.stringify({ id: "req-1", run: run.id, at: "t", by: "cli" }),
    );
    expect(b.scan.consumeStopRequest()).toBeNull();
    expect(a.scan.consumeStopRequest()).toMatchObject({ request: "req-1", ok: true });
    await a.scan.idle();
    expect(a.scan.status().run!.state).toBe("stopped");
  });

  it("the lease is given up when the run ends, so the next start is free", async () => {
    const { a, b } = await startHanging();
    a.scan.stop();
    await a.scan.idle();
    expect(a.lease.other()).toBeNull();
    expect(b.lease.other()).toBeNull();
    const p = await b.scan.preview();
    if (!p.ok) throw new Error("preview");
    expect((await b.scan.start({ key: p.preview.key })).ok).toBe(true);
    await b.scan.idle();
  });

  it("a lease its holder stopped renewing lapses: the run reads as interrupted", async () => {
    const { a, b, run } = await startHanging();
    b.advance(LEASE_TTL_MS + 1);
    expect(b.scan.status().run).toMatchObject({ id: run.id, display: "interrupted" });
    a.scan.stop();
    await a.scan.idle();
  });

  it("an unreadable lease file is no lease", async () => {
    const rig = scanRig({ dir });
    mkdirSync(join(rig.home, "scan"), { recursive: true });
    writeFileSync(join(rig.home, DRIVER_FILE), "{not json");
    expect(rig.lease.other()).toBeNull();
    const p = await rig.scan.preview();
    if (!p.ok) throw new Error("preview");
    expect((await rig.scan.start({ key: p.preview.key })).ok).toBe(true);
    await rig.scan.idle();
  });
});
