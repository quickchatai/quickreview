// extensions/setup-scan.ts — the scan half of the companion's setup belt
//, driven over a ScanRunner with faked ports and a temp state home:
// what each tool SAYS for a preview, a start, a refusal, the status and the
// stored findings. The run's own behaviour is tests/scan-run.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { scanToolDefinitions, watchTuiRequests } from "../extensions/setup-scan.js";
import { SCAN_DEFAULTS } from "../src/config.js";
import { stateHomeFs } from "../src/setup/adapters.js";
import { FindingsStore } from "../src/setup/findings.js";
import { ScanRunner } from "../src/setup/scanrun.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "qcr-scan-ext-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const SHA = "a".repeat(40);
const FILES: Record<string, string> = { "app/a.py": "one\ntwo\nthree\n", "lib/b.py": "x\ny\n", "lib/tests/test_b.py": "t\n" };

let tick = 0;

function belt(trees: Record<string, Record<string, string>> = { [SHA]: FILES }, head = SHA): { defs: PiToolDefinition[]; scan: ScanRunner } {
  const state = stateHomeFs(join(dir, "state"));
  const listOf = (sha: string) => Object.keys(trees[sha] ?? {}).map((path) => ({ path, blob: `b-${path}-${JSON.stringify(trees[sha]![path])}` }));
  const scan = new ScanRunner({
    state,
    // Advancing: a run's id is its start second, and two runs must differ.
    clock: () => new Date(Date.parse("2026-09-29T10:00:00Z") + 1000 * tick++),
    cases: {
      run: async (spec) => ({
        ok: true,
        cost_usd: 0.02,
        output: `FINDINGS pass-scan SCAN ${spec.id} @${SHA}\n- path: ${spec.files[0]}\n  line: 1-2\n  kind: bug\n  severity: P2\n  claim: it breaks\n\nSUGGEST NONE\n`,
      }),
    },
    source: {
      location: "/reviewed-repo",
      resolve: (ref) => (ref === "HEAD" ? head : ref in trees ? ref : null),
      open: (sha) => ({
        ok: true,
        tree: {
          sha,
          root: "/tree",
          files: listOf(sha),
          read: (p) => trees[sha]?.[p] ?? null,
          lines: (p) => (trees[sha]?.[p] === undefined ? null : trees[sha]![p]!.split("\n").length - 1),
        },
      }),
      list: (sha) => (trees[sha] ? listOf(sha) : null),
    },
    savedCut: () => ({
      ok: true,
      cut: { units: ["app", "lib"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })), ignored: [] },
    }),
    settings: () => ({ ok: true, settings: { scan: SCAN_DEFAULTS, validateTier: "sol-high" } }),
    buildAgents: () => ({ ok: true }),
  });
  const settings = { scan: SCAN_DEFAULTS, validateTier: "sol-high" as const, riskPasses: ["pass-data-safety"] };
  return { defs: scanToolDefinitions(scan, new FindingsStore(state), () => settings), scan };
}

async function call(defs: PiToolDefinition[], name: string, params: Record<string, unknown> = {}): Promise<string> {
  const def = defs.find((d) => d.name === name)!;
  return (await def.execute("id", params)).content.map((c) => c.text).join("\n");
}

describe("the scan tools", () => {
  it("preview offers calibration first, start needs its key, status and findings follow the run", async () => {
    const { defs, scan } = belt();
    const preview = await call(defs, "scan_preview");
    expect(preview).toMatch(/^CALIBRATION run at aaaaaaaaaaaa/);
    expect(preview).toMatch(/stops hard at \$3\.00/);
    const key = /scan_start with key (\w+)/.exec(preview)![1]!;

    expect(await call(defs, "scan_start", {})).toMatch(/Scan start refused:\n✗ no preview key/);
    expect(await call(defs, "scan_stop")).toMatch(/no scan is running/);
    expect(await call(defs, "scan_start", { key })).toMatch(/started at aaaaaaaaaaaa: 2 case\(s\), hard stop \$3\.00/);
    await scan.idle();

    expect(await call(defs, "scan_status")).toMatch(/COMPLETE — 2\/2 cases, 2 finding\(s\), spent \$0\.04 of \$3\.00/);
    const findings = await call(defs, "scan_findings", { unit: "app" });
    expect(findings).toMatch(/^- \[P2\] app\/a\.py:1-2 \(app, bug, new, unvalidated\) it breaks \[[0-9a-f]{12}\]$/);
    expect(await call(defs, "scan_findings", { state: "bogus" })).toMatch(/Unknown state/);

    // Priced now: the next preview is stage 1 — and nothing is left to read.
    expect(await call(defs, "scan_preview")).toMatch(/✗ nothing left to read/);
  });
});

describe("the delta and match tools", () => {
  it("a delta preview reads only what changed; the match question is shown, answered and settled", async () => {
    const SHA2 = "b".repeat(40);
    const trees = { [SHA]: FILES, [SHA2]: { ...FILES, "app/a.py": "ONE\nTWO\nthree\n" } };
    const { defs, scan } = belt(trees);
    // Calibrate (both units), which is the whole repo here.
    const key = /scan_start with key (\w+)/.exec(await call(defs, "scan_preview"))![1]!;
    await call(defs, "scan_start", { key });
    await scan.idle();

    const delta = await call(defs, "scan_preview", { sha: SHA2, delta: true });
    expect(delta).toMatch(/^DELTA re-scan at bbbbbbbbbbbb .* against the last scan at aaaaaaaaaaaa\./);
    expect(delta).toMatch(/1 files, 3 lines in 1 case\(s\) — 1 already read at this content\./);
    expect(delta).toMatch(/and delta true/);
    const dkey = /scan_start with key (\w+)/.exec(delta)![1]!;
    expect(await call(defs, "scan_start", { key: dkey, sha: SHA2 })).toMatch(/refused/);
    expect(await call(defs, "scan_start", { key: dkey, sha: SHA2, delta: true })).toMatch(/\(delta\) started/);
    await scan.idle();
    expect(await call(defs, "scan_status")).toMatch(/Findings no longer reported: 0 fixed, 1 waiting on your match \(scan_matches\)/);

    const q = await call(defs, "scan_matches");
    expect(q).toMatch(/^MATCH QUESTION (\w+)/);
    const qkey = /^MATCH QUESTION (\w+)/.exec(q)![1]!;
    const [oldFp, newFp] = [...q.matchAll(/^ {2}- ([0-9a-f]{64}) /gm)].map((m) => m[1]!);
    expect(await call(defs, "scan_match", { key: "stale", pairs: [] })).toMatch(/^Match refused:\n✗ the question moved/);
    expect(await call(defs, "scan_match", { key: qkey, pairs: [{ old: oldFp, new: newFp }] })).toBe("Settled: 1 matched (state kept), 0 fixed, 0 new.");
    expect(await call(defs, "scan_matches")).toMatch(/^No match question is pending/);
  });
});

describe("the stage 2 tools", () => {
  it("suggestions name the usable lenses; a proposal shows its rows, pairs and cost; the start takes its key", async () => {
    const { defs, scan } = belt();
    const cal = await call(defs, "scan_preview");
    await call(defs, "scan_start", { key: /scan_start with key (\w+)/.exec(cal)![1]! });
    await scan.idle();

    const sugs = await call(defs, "scan_suggestions");
    expect(sugs).toMatch(/^No deep-lens suggestions stored/);
    expect(sugs).toMatch(/Stage 2 may run: .*pass-security \(terra-med\|sol-med\|sol-high\)/);
    expect(sugs).toMatch(/pass-data-safety \(sol-high\)/);
    expect(sugs).not.toMatch(/pass-intent/);

    expect(await call(defs, "scan_stage2_propose", { rows: [{ lens: "pass-intent", files: ["app/a.py"], reason: "r" }] })).toMatch(
      /^Stage 2 proposal refused:\n✗ row-1: "pass-intent" is not a deep lens/,
    );
    const proposal = await call(defs, "scan_stage2_propose", {
      rows: [{ lens: "pass-security", files: ["app/a.py", "lib/b.py"], reason: "auth crosses both" }],
    });
    expect(proposal).toMatch(/^STAGE 2 proposal at aaaaaaaaaaaa — 1 row\(s\) to run, estimate \$\d+\.\d\d \(the run stops hard there\); validator off\./);
    expect(proposal).toMatch(/row-1: pass-security at sol-med over app \+ lib \(cross-module\) — 2 file\(s\) \+ 1 paired test\(s\)/);
    expect(proposal).toMatch(/extrapolated from pass-scan/);
    expect(proposal).toMatch(/tests: lib\/tests\/test_b\.py/);
    const key = /scan_stage2_start with key (\w+)/.exec(proposal)![1]!;

    expect(await call(defs, "scan_stage2_start", { key: "nope" })).toMatch(/^Stage 2 start refused:\n✗ nope is not the latest/);
    expect(await call(defs, "scan_stage2_start", { key })).toMatch(/^Stage 2 scan-\S+ started at aaaaaaaaaaaa: 1 row\(s\), hard stop/);
    await scan.idle();
    const status = await call(defs, "scan_status");
    expect(status).toMatch(/\(stage 2\) at aaaaaaaaaaaa: COMPLETE — 1\/1 cases/);
    expect(status).toMatch(/- row-1 pass-security at sol-med \(app, lib\): done/);
    expect(status).toMatch(/3 file × lens read by stage 2/);
  });

  it("the watcher polls for the TUI's click and stop, and stops when told", async () => {
    vi.useFakeTimers();
    try {
      const consumeStage2Request = vi.fn(async () => null);
      const consumeStopRequest = vi.fn(() => null);
      const stop = watchTuiRequests({ consumeStage2Request, consumeStopRequest } as unknown as ScanRunner, 1000);
      await vi.advanceTimersByTimeAsync(3000);
      expect(consumeStage2Request).toHaveBeenCalledTimes(3);
      expect(consumeStopRequest).toHaveBeenCalledTimes(3);
      stop();
      await vi.advanceTimersByTimeAsync(3000);
      expect(consumeStage2Request).toHaveBeenCalledTimes(3);
      expect(consumeStopRequest).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
