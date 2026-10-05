// The scan report's read side and its stop channel (,
// src/setup/scanreport.ts): what the TUI's `[8] scan` tab reads out of the
// state home, and the stop it asks the companion for. Driven the engine way —
// a real ScanRunner over fakes, the state home a temp dir — and asserted on
// what the engine and the leaf WRITE and RETURN.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SCAN_DEFAULTS } from "../src/config.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import type { CaseOutcome, CaseSpec } from "../src/setup/engine.js";
import { FINDINGS_FILE as STORE_FILE } from "../src/setup/findings.js";
import {
  clickStopScan,
  FINDINGS_FILE,
  readScanFindings,
  readScanRuns,
  RUN_FILE,
  SCAN_STOP_FILE,
  SCAN_STOP_RESULT_FILE,
  scanStopOutcome,
} from "../src/setup/scanreport.js";
import {
  RUN_FILE as RUNNER_FILE,
  ScanRunner,
  type ScanPorts,
  type ScanTree,
} from "../src/setup/scanrun.js";
import type { UnitCut } from "../src/setup/unitcut.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scanreport-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const text = (n: number, w: string): string =>
  Array.from({ length: n }, (_, i) => `${w}_${i} = ${i}`).join("\n") + "\n";
const TREE: Record<string, string> = {
  "app/a.py": text(10, "a"),
  "lib/b.py": text(20, "b"),
  "web/c.ts": text(30, "c"),
};
const CUT: UnitCut = {
  units: ["app", "lib", "web"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })),
  ignored: [],
};
const SHA = "2".repeat(40);
const blob = (t: string): string =>
  createHash("sha1")
    .update(`blob ${Buffer.byteLength(t)}\0${t}`)
    .digest("hex");

/** A case runner whose cases run until aborted — a scan held "in flight". */
function hangingRunner(): {
  run(spec: CaseSpec, signal: AbortSignal): Promise<CaseOutcome>;
  started: number;
} {
  const r = {
    started: 0,
    run: (_spec: CaseSpec, signal: AbortSignal): Promise<CaseOutcome> => {
      r.started++;
      return new Promise((res) =>
        signal.addEventListener("abort", () => res({ ok: false, reason: "aborted", cost_usd: 0 })),
      );
    },
  };
  return r;
}

function ports(cases: ScanPorts["cases"]): ScanPorts {
  let t = new Date("2026-09-29T10:00:00Z").getTime();
  return {
    state: stateHomeFs(dir),
    clock: () => new Date((t += 1000)),
    cases,
    source: {
      location: "/repo",
      resolve: (ref) => (ref === "HEAD" || ref === SHA ? SHA : null),
      open: (sha): { ok: true; tree: ScanTree } => ({
        ok: true,
        tree: {
          sha,
          root: "/tree",
          files: Object.entries(TREE).map(([path, t2]) => ({ path, blob: blob(t2) })),
          read: (p) => TREE[p] ?? null,
          lines: (p) => (TREE[p] === undefined ? null : TREE[p]!.split("\n").length - 1),
        },
      }),
      list: () => Object.entries(TREE).map(([path, t2]) => ({ path, blob: blob(t2) })),
    },
    savedCut: () => ({ ok: true, cut: CUT }),
    settings: () => ({ ok: true, settings: { scan: { ...SCAN_DEFAULTS, validator: false } } }),
    buildAgents: () => ({ ok: true }),
  };
}

async function startHanging(): Promise<{ s: ScanRunner; run: string }> {
  const s = new ScanRunner(ports(hangingRunner()));
  const p = await s.preview();
  if (!p.ok) throw new Error(p.errors.join("; "));
  const r = await s.start({ key: p.preview.key });
  if (!r.ok) throw new Error(r.errors.join("; "));
  return { s, run: r.run.id };
}

describe("the records the TUI reads", () => {
  it("owns the file names the engine writes — one spelling each", () => {
    expect(RUN_FILE).toBe(RUNNER_FILE);
    expect(FINDINGS_FILE).toBe(STORE_FILE);
  });

  it("each record is absent, read, or unreadable with the reason — never an empty list for a file it could not read", async () => {
    expect(readScanRuns(dir)).toEqual({ kind: "absent" });
    expect(readScanFindings(dir)).toEqual({ kind: "absent" });

    const { s, run } = await startHanging();
    const runs = readScanRuns(dir);
    expect(runs.kind).toBe("read");
    if (runs.kind === "read")
      expect(runs.value.current).toMatchObject({ id: run, state: "running" });
    s.stop();
    await s.idle();

    mkdirSync(join(dir, "scan"), { recursive: true });
    writeFileSync(join(dir, FINDINGS_FILE), '{"version": 9, "findings": []}');
    expect(readScanFindings(dir)).toMatchObject({
      kind: "unreadable",
      why: expect.stringMatching(/not a record this version reads/),
    });
    writeFileSync(join(dir, RUN_FILE), "{ torn");
    expect(readScanRuns(dir)).toMatchObject({ kind: "unreadable" });
  });
});

describe("stopping a scan from the TUI", () => {
  it("the click names the run it showed running; the companion stops exactly that run and answers once", async () => {
    const { s, run } = await startHanging();
    const click = clickStopScan(dir, run, new Date("2026-09-29T11:00:00Z"));
    expect(click).toMatchObject({
      ok: true,
      line: expect.stringContaining(`stop asked for ${run}`),
    });
    if (!click.ok) return;
    expect(scanStopOutcome(dir, click.request)).toBeNull();

    expect(s.consumeStopRequest()).toMatchObject({ ok: true, run, request: click.request });
    await s.idle();
    expect(s.status().run).toMatchObject({ id: run, state: "stopped" });
    expect(scanStopOutcome(dir, click.request)).toBe(
      `scan ${run} stopped — what finished is in the ledger`,
    );
    // Answered once: the same request is never replayed onto a later run.
    const again = await startHanging().catch(() => null);
    expect(again).not.toBeNull();
    expect(again!.s.consumeStopRequest()).toBeNull();
    again!.s.stop();
    await again!.s.idle();
  });

  it("a click on a run that is not running is refused at the TUI", async () => {
    expect(clickStopScan(dir, "scan-x")).toMatchObject({
      ok: false,
      line: expect.stringMatching(/no longer running/),
    });
    const { s, run } = await startHanging();
    expect(clickStopScan(dir, "scan-other")).toMatchObject({ ok: false });
    s.stop();
    await s.idle();
    expect(clickStopScan(dir, run)).toMatchObject({
      ok: false,
      line: expect.stringMatching(/no longer running/),
    });
    expect(() => readFileSync(join(dir, SCAN_STOP_FILE), "utf8")).toThrow();
  });

  it("the companion refuses a stop for a run it is not driving — never aimed at whatever runs now", async () => {
    const { s, run } = await startHanging();
    clickStopScan(dir, run);
    // A companion that restarted holds no run in flight: the record still
    // says running, nothing is there to stop.
    const fresh = new ScanRunner(ports(hangingRunner()));
    expect(fresh.consumeStopRequest()).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/no scan is running in this companion/)],
    });
    expect(JSON.parse(readFileSync(join(dir, SCAN_STOP_RESULT_FILE), "utf8")).ok).toBe(false);
    // Stale request naming another run, while one IS in flight here.
    writeFileSync(
      join(dir, SCAN_STOP_FILE),
      JSON.stringify({ id: "r2", run: "scan-older", at: "", by: "tui" }),
    );
    expect(s.consumeStopRequest()).toMatchObject({
      ok: false,
      errors: [expect.stringMatching(/in flight is .*, not scan-older/)],
    });
    expect(s.status().run).toMatchObject({ state: "running" });
    s.stop();
    await s.idle();
  });
});
