// extensions/setup-scan.ts — the scan half of the companion's setup belt
//, driven over a ScanRunner with faked ports and a temp state home:
// what each tool SAYS for a preview, a start, a refusal, the status and the
// stored findings. The run's own behaviour is tests/scan-run.test.ts's.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PiToolDefinition } from "@earendil-works/pi-coding-agent";
import { scanToolDefinitions } from "../extensions/setup-scan.js";
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
const FILES: Record<string, string> = { "app/a.py": "one\ntwo\nthree\n", "lib/b.py": "x\ny\n" };

function belt(): { defs: PiToolDefinition[]; scan: ScanRunner } {
  const state = stateHomeFs(join(dir, "state"));
  const scan = new ScanRunner({
    state,
    clock: () => new Date("2026-09-29T10:00:00Z"),
    cases: {
      run: async (spec) => ({
        ok: true,
        cost_usd: 0.02,
        output: `FINDINGS pass-scan SCAN ${spec.id} @${SHA}\n- path: ${spec.files[0]}\n  line: 1-2\n  kind: bug\n  severity: P2\n  claim: it breaks\n\nSUGGEST NONE\n`,
      }),
    },
    source: {
      location: "/reviewed-repo",
      resolve: (ref) => (ref === "HEAD" || ref === SHA ? SHA : null),
      open: (sha) => ({
        ok: true,
        tree: {
          sha,
          root: "/tree",
          files: Object.keys(FILES).map((path) => ({ path, blob: `b-${path}` })),
          read: (p) => FILES[p] ?? null,
          lines: (p) => (FILES[p] === undefined ? null : FILES[p]!.split("\n").length - 1),
        },
      }),
    },
    savedCut: () => ({
      ok: true,
      cut: { units: ["app", "lib"].map((u) => ({ name: u, roots: [u], kind: "directory", note: "" })), ignored: [] },
    }),
    settings: () => ({ ok: true, settings: { scan: SCAN_DEFAULTS, validateTier: "sol-high" } }),
    buildAgents: () => ({ ok: true }),
  });
  return { defs: scanToolDefinitions(scan, new FindingsStore(state)), scan };
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
